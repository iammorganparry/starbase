import type { CliInfo, ContextDigest, ContextSnapshot, Message, StreamEvent } from "@starbase/core"
import {
  DEFAULT_CONTEXT_CONFIG,
  contextPhase,
  contextWindowFor,
  defaultModel,
  digestModelFor,
  triggerAt
} from "@starbase/core"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Effect, Fiber, Ref } from "effect"
import { AppPaths } from "./app-paths.js"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import { ConfigService } from "./config.js"
import { digestPrompt, lastMessageId, parseDigest, renderTranscript } from "./context-digest.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"

/**
 * Async context management — the part that decides WHEN to compact and does the
 * expensive half off the critical path.
 *
 * The shape of the whole feature: when a turn ends above the budget we fork a
 * detached fiber that summarises the transcript while the user reads the answer.
 * By the time they send their next prompt the digest is usually sitting ready,
 * and applying it costs nothing — it is just "build the next spec differently".
 * The user never waits.
 *
 * Everything here degrades toward doing nothing. A failed digest, an unknown
 * window, a harness that doesn't report usage: all of them leave the session
 * behaving exactly as it does today, with the harness's own limit still the
 * backstop. That asymmetry is deliberate — the cost of not compacting is a
 * slower session, and the cost of compacting wrongly is a session that has
 * forgotten what it was doing.
 */

/** How long a digest run may take before we give up and leave the session alone. */
const DIGEST_TIMEOUT = "90 seconds"

/**
 * How many consecutive digest failures before a session stops trying.
 *
 * One retry, then silence. A session whose digest keeps failing (an unparseable
 * model, a harness that won't start) would otherwise fork a doomed fiber on
 * every single turn forever — burning the user's tokens on a background task
 * that has never once produced a result they can see.
 */
const MAX_FAILURES = 2

interface SessionContext {
  readonly status: "idle" | "preparing" | "ready"
  readonly digest: ContextDigest | null
  readonly tokens: number
  readonly failures: number
  readonly compactions: number
  readonly lastCompactedAt: string | null
}

const EMPTY: SessionContext = {
  status: "idle",
  digest: null,
  tokens: 0,
  failures: 0,
  compactions: 0,
  lastCompactedAt: null
}

export type DigestEnv =
  | CliAdapter
  | SessionStore
  | TranscriptStore
  | ConfigService
  | DiscoveryService
  // `DiscoveryService.list()` shells out to probe for harness binaries, which is
  // how the digest learns which one the session is authenticated against.
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

export class ContextManager extends Effect.Service<ContextManager>()(
  "@starbase/ContextManager",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const states = yield* Ref.make(new Map<string, SessionContext>())
      /** Live digest fibers, so a stopped or deleted session can cancel its own. */
      const fibers = yield* Ref.make(new Map<string, Fiber.RuntimeFiber<void, never>>())

      /**
       * Harness discovery, memoised for 30s.
       *
       * `DiscoveryService.list()` shells out `which` + `--version` for every
       * harness — roughly eight processes per call — and does not cache. This
       * service needs it on EVERY `snapshot`, which the meter polls once a second
       * and a half while a turn runs, so calling straight through meant spawning
       * eight processes a second per open session just to draw a progress bar.
       *
       * Hand-rolled rather than `Effect.cachedWithTTL` because that resolves the
       * effect at CONSTRUCTION time, which would turn discovery into a layer
       * dependency of this service and force every consumer to rewire. Keeping it
       * per-call leaves the service's shape unchanged.
       *
       * A TTL rather than a permanent cache so installing or upgrading a harness
       * takes effect within half a minute, without a restart.
       */
      const cliCache = yield* Ref.make<{ at: number; value: ReadonlyArray<CliInfo> } | null>(null)
      const CLI_TTL_MS = 30_000

      const listClis = (): Effect.Effect<
        ReadonlyArray<CliInfo>,
        never,
        DiscoveryService | CommandExecutor.CommandExecutor
      > =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => Date.now())
          const cached = yield* Ref.get(cliCache)
          if (cached !== null && now - cached.at < CLI_TTL_MS) return cached.value
          const fresh = yield* DiscoveryService.list().pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<CliInfo>)
          )
          yield* Ref.set(cliCache, { at: now, value: fresh })
          return fresh
        })

      const stateOf = (sessionId: string): Effect.Effect<SessionContext> =>
        Effect.map(Ref.get(states), (m) => m.get(sessionId) ?? EMPTY)

      const setState = (
        sessionId: string,
        fn: (prev: SessionContext) => SessionContext
      ): Effect.Effect<void> =>
        Ref.update(states, (m) => new Map(m).set(sessionId, fn(m.get(sessionId) ?? EMPTY)))

      /**
       * Resolve everything the policy needs for a session: its window, its
       * budget, and whether auto-compaction applies to it at all.
       *
       * Every lookup here is best-effort. This runs on the hot path of a turn
       * ending, and a config read that failed must not take the turn down with
       * it — it just means we don't compact.
       */
      const settingsFor = (sessionId: string) =>
        Effect.gen(function* () {
          const session = yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
          if (session === null) return null

          const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          const ctx = config?.context ?? DEFAULT_CONTEXT_CONFIG
          const provider = config?.providers?.[session.cli]

          const cli = (yield* listClis()).find((c) => c.kind === session.cli)

          // A harness that reports no usage gives us nothing to measure, so it is
          // left alone rather than compacted against a fabricated number.
          const reporting = cli?.contextReporting ?? false
          // The per-session switch overrides the global one in both directions,
          // so a user can pin one long-running session open (or force it on).
          const auto = (session.autoCompact ?? ctx.auto) && reporting

          return {
            session,
            auto,
            budget: ctx.budgetTokens,
            window: contextWindowFor(session.cli, session.model ?? null, provider?.contextWindow),
            binPath: cli?.binPath ?? null,
            digestModel: digestModelFor(session.cli, provider?.backgroundModel)
          }
        })

      /**
       * Summarise the session's transcript through its OWN harness.
       *
       * The single most important property in this file: `CliAdapter.run` with
       * the session's `binPath` means the summary is produced by the CLI the user
       * has already authenticated — their Claude subscription, their Codex login.
       * There is no API client constructed anywhere in this codepath and no key
       * to configure, so enabling auto-compaction cannot present anyone with a
       * bill they didn't expect. It runs on `backgroundModel` (haiku by default),
       * so it is also the cheapest tier that harness offers.
       */
      const buildDigest = (sessionId: string): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          const settings = yield* settingsFor(sessionId)
          if (settings === null) return yield* fail(sessionId)

          const messages = yield* TranscriptStore.list(sessionId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          const through = lastMessageId(messages)
          // Nothing to summarise. Not a failure — just a session that crossed the
          // threshold on a single enormous turn, which no digest can help with.
          if (through === null) return yield* Effect.void

          const adapter = yield* CliAdapter
          const collected = yield* Ref.make<ReadonlyArray<string>>([])

          const spec: SessionSpec = {
            cli: settings.session.cli,
            repo: settings.session.repo,
            branch: settings.session.branch,
            cwd: settings.session.worktreePath ?? "",
            prompt: digestPrompt(renderTranscript(messages)),
            images: [],
            binPath: settings.binPath,
            // "ask" pairs with the deny-all gate below. Not "plan": plan mode
            // steers the harness toward ExitPlanMode, and a summariser that
            // proposes a plan instead of answering is useless.
            mode: "ask",
            // The cheap tier, on the user's existing subscription.
            model: settings.digestModel || defaultModel(settings.session.cli),
            resumeId: null,
            // `resumeId: null` is NOT enough on its own — the adapter prefers its
            // in-memory resume map, keyed per session, so without this the digest
            // run would resume the very conversation it is trying to summarise
            // and inherit the context we are attempting to shed.
            fresh: true,
            // A summariser has no business touching the worktree. Enforced in the
            // harness because the deny-all gate below is not a control surface for
            // every adapter — Codex never calls it at all.
            readOnly: true
          }

          const ctx: AgentContext = {
            emit: (event: StreamEvent) =>
              // Main-thread text ONLY. If the digest run spawned a sub-agent, its
              // chatter would interleave into the reply we parse — and any JSON it
              // happened to print would win the "last block" race in `parseDigest`,
              // silently replacing the real summary with a fragment.
              event._tag === "Assistant" && event.agentId === undefined
                ? Ref.update(collected, (acc) => [...acc, event.text])
                : Effect.void,
            canUseTool: () => Effect.succeed("deny" as const),
            askQuestion: () => Effect.succeed([]),
            proposePlan: () => Effect.succeed(PlanDecision.Reject()),
            // Deliberately dropped. This is a nested run against a session that
            // already has a real agent; registering a stop handle here would
            // overwrite that agent's, aiming the dock's Stop button at the wrong
            // process.
            registerBackgroundStop: () => Effect.void
          }

          const ok = yield* adapter
            .run(`digest_${sessionId}`, spec, ctx)
            .pipe(
              Effect.timeout(DIGEST_TIMEOUT),
              Effect.as(true),
              Effect.orElseSucceed(() => false)
            )
          if (!ok) return yield* fail(sessionId)

          const raw = (yield* Ref.get(collected)).join("\n")
          const builtAt = yield* Effect.sync(() => new Date().toISOString())
          const digest = parseDigest(raw, through, builtAt)
          // A null digest is a real answer, not an error to smooth over: we simply
          // don't compact, and the session behaves exactly as it does today.
          if (digest === null) return yield* fail(sessionId)

          yield* setState(sessionId, (s) => ({ ...s, status: "ready", digest, failures: 0 }))
        })

      const fail = (sessionId: string): Effect.Effect<void> =>
        setState(sessionId, (s) => ({
          ...s,
          status: "idle",
          digest: null,
          failures: s.failures + 1
        }))

      /** Fork the digest as a daemon so it outlives the turn that triggered it. */
      const fork = (sessionId: string): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          yield* setState(sessionId, (s) => ({ ...s, status: "preparing" }))
          const fiber = yield* Effect.forkDaemon(
            buildDigest(sessionId).pipe(
              Effect.ensuring(Ref.update(fibers, (m) => {
                const next = new Map(m)
                next.delete(sessionId)
                return next
              }))
            )
          )
          yield* Ref.update(fibers, (m) => new Map(m).set(sessionId, fiber))
        })

      /**
       * Record a context reading and decide whether to start preparing.
       *
       * Called as a turn settles. Returns immediately in every branch — the work
       * it may start runs on a daemon fiber, because the whole point is that the
       * user is never waiting on it.
       */
      const observe = (
        sessionId: string,
        tokens: number
      ): Effect.Effect<void, never, SessionStore | FileSystem.FileSystem | AppPaths> =>
        Effect.gen(function* () {
          if (!Number.isFinite(tokens) || tokens <= 0) return
          yield* setState(sessionId, (s) => ({ ...s, tokens }))
          // Persist so the reading survives a restart — otherwise a session
          // reopened at 290k reads as 0 and runs to the ceiling.
          yield* SessionStore.setContextTokens(sessionId, tokens).pipe(Effect.ignore)
        })

      /**
       * Record a reading AND decide whether to start preparing a digest.
       *
       * Called only when a turn has SETTLED, and that distinction is
       * load-bearing. Claude and opencode report usage per assistant message, so
       * a turn that uses tools reports several times before it finishes. Forking
       * on one of those mid-turn readings builds the digest from a transcript
       * whose last message is still streaming — and since the digest stamps
       * `throughMessageId` with that message's id, `tailAfter` then slices AFTER
       * it at swap time. Every tool result and closing paragraph that landed on
       * that same message afterwards is neither summarised nor replayed: the
       * compacted context silently loses the tail of the very turn that
       * triggered it.
       *
       * Readings still arrive continuously through `observe`; only the decision
       * to summarise waits for a coherent transcript.
       */
      const settle = (
        sessionId: string,
        tokens: number
      ): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          yield* observe(sessionId, tokens)
          if (!Number.isFinite(tokens) || tokens <= 0) return

          const settings = yield* settingsFor(sessionId)
          if (settings === null) return

          const state = yield* stateOf(sessionId)
          // A session that has failed repeatedly stops trying, rather than
          // forking a doomed fiber on every turn forever.
          if (state.failures >= MAX_FAILURES) return
          if (state.status !== "idle") return

          const phase = contextPhase({
            tokens,
            window: settings.window,
            budget: settings.budget,
            auto: settings.auto,
            digestReady: state.digest !== null
          })
          if (phase !== "prepare") return
          yield* fork(sessionId)
        })

      /**
       * Force a digest regardless of the budget — the manual "Compact now".
       *
       * Still refuses when the session is already preparing (a second fiber would
       * race the first) and still requires a measurable harness, because a manual
       * compaction against a fabricated reading is no better than an automatic one.
       */
      const compactNow = (sessionId: string): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          const state = yield* stateOf(sessionId)
          if (state.status === "preparing") return
          if (state.status === "ready") return
          const settings = yield* settingsFor(sessionId)
          if (settings === null || settings.window === null) return
          // A manual request clears the failure count: the user asking again is a
          // reasonable signal to stop giving up.
          yield* setState(sessionId, (s) => ({ ...s, failures: 0 }))
          yield* fork(sessionId)
        })

      /**
       * Consume a ready digest, if there is one. Called at the top of a turn.
       *
       * Returns the digest exactly once — the state flips to idle in the same
       * update — so a swap can never be applied twice, which would reseed a fresh
       * conversation with a summary of the conversation it just replaced.
       */
      const applyIfReady = (sessionId: string): Effect.Effect<ContextDigest | null> =>
        Effect.gen(function* () {
          const state = yield* stateOf(sessionId)
          if (state.status !== "ready" || state.digest === null) return null
          const at = yield* Effect.sync(() => new Date().toISOString())
          yield* setState(sessionId, (s) => ({
            ...s,
            status: "idle",
            digest: null,
            failures: 0,
            compactions: s.compactions + 1,
            lastCompactedAt: at
          }))
          return state.digest
        })

      /** Cancel a session's in-flight digest and forget it (stop / delete). */
      const cancel = (sessionId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const fiber = (yield* Ref.get(fibers)).get(sessionId)
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
          yield* Ref.update(fibers, (m) => {
            const next = new Map(m)
            next.delete(sessionId)
            return next
          })
          yield* setState(sessionId, (s) => ({ ...s, status: "idle", digest: null }))
        })

      /** Everything the meter and Settings need to describe a session. */
      const snapshot = (
        sessionId: string
      ): Effect.Effect<ContextSnapshot, never, DigestEnv> =>
        Effect.gen(function* () {
          const state = yield* stateOf(sessionId)
          const settings = yield* settingsFor(sessionId)
          // Prefer the live in-memory reading, fall back to the persisted one so a
          // freshly reopened session shows its real size before its first turn.
          const tokens = state.tokens > 0 ? state.tokens : settings?.session.contextTokens ?? 0
          const window = settings?.window ?? null
          const budget = settings?.budget ?? DEFAULT_CONTEXT_CONFIG.budgetTokens
          return {
            sessionId,
            tokens,
            window,
            budget,
            triggerAt: window === null ? null : triggerAt(window, budget),
            phase: contextPhase({
              tokens,
              window,
              budget,
              auto: settings?.auto ?? false,
              digestReady: state.digest !== null
            }),
            preparing: state.status === "preparing",
            digestReady: state.digest !== null,
            lastCompactedAt: state.lastCompactedAt,
            compactions: state.compactions,
            // Mirrors the guard in `settle` exactly — this is the same ceiling
            // that stops the fork, reported so the meter can say so.
            stalled: state.failures >= MAX_FAILURES
          }
        })

      return { observe, settle, applyIfReady, compactNow, cancel, snapshot }
    })
  }
) {}
