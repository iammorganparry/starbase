import type {
  BackgroundTask,
  CliInfo,
  ContextDigest,
  ContextSnapshot,
  Message,
  StreamEvent
} from "@starbase/core"
import {
  DEFAULT_CONTEXT_CONFIG,
  contextPhase,
  contextWindowFor,
  defaultModel,
  digestModelFor,
  reconcileWindow,
  shouldHoldSwap,
  triggerAt
} from "@starbase/core"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Effect, Fiber, Ref } from "effect"
import { AppPaths } from "./app-paths.js"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { BackgroundTaskStore } from "./background-tasks.js"
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

/**
 * Legacy Codex sessions created before live occupancy telemetry can resume with
 * `contextTokens: 0`. A large local transcript is then the only evidence that
 * resuming the vendor thread is unsafe.
 */
const UNKNOWN_CODEX_TRANSCRIPT_RECOVERY_CHARS = 500_000

interface SessionContext {
  readonly status: "idle" | "preparing" | "ready"
  readonly digest: ContextDigest | null
  /**
   * Whether the next turn must wait for an in-flight digest.
   *
   * Set only after a hard context overflow. Routine and manually requested
   * background digests must never stall the operator's next prompt.
   */
  readonly waitForReady: boolean
  /** Latest OCCUPANCY reading, from a `Usage` event. Never a cumulative total. */
  readonly tokens: number
  /**
   * The largest occupancy this session has ever reported.
   *
   * Kept because it DISPROVES a wrong window: a harness that held 598k cannot
   * have a 200k ceiling, whatever the model-id table guessed. Survives a
   * compaction (unlike `tokens`) — the ceiling did not change just because the
   * conversation was reseeded.
   */
  readonly peakTokens: number
  /**
   * The ceiling the harness itself reported, when it reports one.
   *
   * A larger measured value raises a conservative model-table entry. A smaller
   * value cannot lower a known window: Codex builds can retain an older
   * effective-session figure after the model family has moved to 1M.
   */
  readonly window: number | null
  readonly failures: number
  readonly compactions: number
  readonly lastCompactedAt: string | null
  /**
   * How many turns in a row this session has declined a ready swap because it
   * was mid-flow. Reset on a real swap, and capped by `MAX_SWAP_DEFERRALS` so a
   * session that always looks busy still compacts eventually.
   */
  readonly deferrals: number
  /** Why the last swap was held, for the meter's tooltip. Null when not holding. */
  readonly heldReason: string | null
}

const EMPTY: SessionContext = {
  status: "idle",
  digest: null,
  waitForReady: false,
  tokens: 0,
  peakTokens: 0,
  window: null,
  failures: 0,
  compactions: 0,
  lastCompactedAt: null,
  deferrals: 0,
  heldReason: null
}

const resolveWindow = (inferred: number | null, reported: number | null): number | null => {
  if (reported === null) return inferred
  if (inferred === null) return reported
  return Math.max(inferred, reported)
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
          const state = yield* stateOf(sessionId)
          const reported = state.window
          // What this session has demonstrably held. A guess below it is not a
          // conservative guess, it is a disproven one.
          const peak = Math.max(state.peakTokens, session.contextTokens ?? 0)

          const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          const ctx = config?.context ?? DEFAULT_CONTEXT_CONFIG
          const provider = config?.providers?.[session.cli]

          const cli = (yield* listClis()).find((c) => c.kind === session.cli)
          const inferredWindow = contextWindowFor(session.cli, session.model ?? null)
          const measuredWindow = resolveWindow(inferredWindow, reported)

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
            // The user's explicit Settings value stays on top because it is the
            // escape hatch for a harness report we have reason to distrust.
            // Otherwise, a known model window is a floor: stale Codex telemetry
            // must not lower GPT-5.6 from 1M to its former 258.4k session value.
            // A larger live report still raises an old or conservative table
            // entry, and an unknown table entry can still use live telemetry.
            //
            // Whatever that resolves to is then reconciled against the largest
            // occupancy this session has actually reported. A model-id table is a
            // guess, and an observation of 598k in a "200k" window disproves it —
            // left uncorrected, `triggerAt` sits at 170k and the session compacts
            // every single turn while the harness is perfectly comfortable.
            window: reconcileWindow(
              provider?.contextWindow !== undefined && provider.contextWindow !== null
                ? contextWindowFor(session.cli, session.model ?? null, provider.contextWindow)
                : measuredWindow,
              peak
            ),
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
          if (settings === null) return yield* fail(sessionId, "session or config unavailable")

          const messages = yield* TranscriptStore.list(sessionId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          const through = lastMessageId(messages)
          // Nothing to summarise. Not a failure — just a session that crossed the
          // threshold on a single enormous turn, which no digest can help with.
          if (through === null) {
            yield* setState(sessionId, (s) => ({
              ...s,
              status: "idle",
              digest: null,
              waitForReady: false
            }))
            return
          }

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
          if (!ok) return yield* fail(sessionId, "run errored or timed out")

          // Concatenate with "", NOT "\n". `collected` holds one entry per
          // streamed text DELTA (see `emit` above), and a harness streams its
          // reply token by token — so joining with "\n" injects a newline at
          // every fragment boundary. When a boundary lands inside a JSON string
          // value (near-certain with token-level streaming) that newline becomes
          // a raw newline inside the string, which is invalid JSON: `parseDigest`
          // then throws and the digest fails EVERY time. The bug was invisible in
          // tests because the scripted adapter emits the whole reply as a single
          // event, where the separator never bites. Deltas are contiguous, so ""
          // reproduces the harness's literal output (its own newlines included).
          const raw = (yield* Ref.get(collected)).join("")
          // An empty reply and an unparseable one are different failures: the
          // first means the run produced no main-thread text at all (deny-all
          // gate, a harness that only emitted tool chatter), the second means it
          // spoke but not in the shape we asked for.
          if (raw.trim().length === 0) return yield* fail(sessionId, "empty digest reply")
          const builtAt = yield* Effect.sync(() => new Date().toISOString())
          const digest = parseDigest(raw, through, builtAt)
          // A null digest is a real answer, not an error to smooth over: we simply
          // don't compact, and the session behaves exactly as it does today.
          if (digest === null) return yield* fail(sessionId, "digest reply did not parse")

          yield* setState(sessionId, (s) => ({ ...s, status: "ready", digest, failures: 0 }))
        })

      /**
       * Record a failed digest attempt and say WHY.
       *
       * The counter + stall behaviour is unchanged — one retry then silence — but
       * the reason is logged so a systematically-failing digest is diagnosable
       * instead of a session that mysteriously stops compacting. This class of bug
       * (a reply that never parsed) was invisible precisely because `fail` said
       * nothing.
       */
      const fail = (sessionId: string, reason: string): Effect.Effect<void> =>
        Effect.zipRight(
          Effect.logWarning(`context digest failed for ${sessionId}: ${reason}`),
          setState(sessionId, (s) => ({
            ...s,
            status: "idle",
            digest: null,
            waitForReady: false,
            failures: s.failures + 1
          }))
        )

      /** Fork the digest as a daemon so it outlives the turn that triggered it. */
      const fork = (
        sessionId: string,
        waitForReady = false
      ): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          yield* setState(sessionId, (s) => ({
            ...s,
            status: "preparing",
            waitForReady
          }))
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
        tokens: number,
        window: number | null = null
      ): Effect.Effect<void, never, SessionStore | FileSystem.FileSystem | AppPaths> =>
        Effect.gen(function* () {
          const measured = window !== null && Number.isFinite(window) && window > 0 ? window : null
          // A reading that only carries a ceiling still teaches us the ceiling.
          if (measured !== null) yield* setState(sessionId, (s) => ({ ...s, window: measured }))
          if (!Number.isFinite(tokens) || tokens <= 0) return
          yield* setState(sessionId, (s) => ({
            ...s,
            tokens,
            // The high-water mark only ever rises: it is evidence about the
            // CEILING, and a compaction shrinking the working set says nothing
            // about how large that ceiling is.
            peakTokens: Math.max(s.peakTokens, tokens)
          }))
          // Persist so the reading survives a restart — otherwise a session
          // reopened at 290k reads as 0 and runs to the ceiling.
          yield* SessionStore.setContextTokens(sessionId, tokens).pipe(Effect.ignore)
        })

      /**
       * Decide whether to start preparing a digest, from the latest reading.
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
      const settle = (sessionId: string): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          const settings = yield* settingsFor(sessionId)
          if (settings === null) return

          const state = yield* stateOf(sessionId)
          // The decision reads the OCCUPANCY the harness reported, which arrives
          // through `observe`. It deliberately takes no reading of its own: the
          // caller's end-of-turn number is cumulative spend on at least one
          // harness, and passing it here is what made compaction fire every turn.
          // Falling back to the persisted value keeps a session that was reopened
          // near its ceiling from reading as empty on its first turn.
          const tokens = state.tokens > 0 ? state.tokens : settings.session.contextTokens ?? 0
          if (!Number.isFinite(tokens) || tokens <= 0) return

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
       * Force a digest regardless of the budget.
       *
       * Manual compaction remains background work. A hard-overflow recovery opts
       * into `waitForReady`, which prevents only that session's immediate retry
       * from reusing the known-full harness thread.
       */
      const compactNow = (
        sessionId: string,
        options: { readonly waitForReady?: boolean } = {}
      ): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          const state = yield* stateOf(sessionId)
          if (state.status === "preparing") {
            // A hard overflow can arrive while an ordinary digest is already
            // building. Promote that existing work instead of forking a rival.
            if (options.waitForReady === true && !state.waitForReady) {
              yield* setState(sessionId, (s) => ({ ...s, waitForReady: true }))
            }
            return
          }
          if (state.status === "ready") return
          const settings = yield* settingsFor(sessionId)
          if (settings === null || settings.window === null) return
          // A manual request clears the failure count: the user asking again is a
          // reasonable signal to stop giving up.
          yield* setState(sessionId, (s) => ({ ...s, failures: 0 }))
          yield* fork(sessionId, options.waitForReady === true)
        })

      /**
       * Prepare a blocking digest for a legacy Codex resume whose occupancy is
       * unknown but whose transcript is already large enough to be risky.
       *
       * This is deliberately narrower than ordinary auto-compaction: measured
       * sessions use their Usage reading, small unknown sessions proceed, and an
       * operator who disabled automatic compaction keeps that choice.
       */
      const prepareUnknownCodexResume = (
        sessionId: string
      ): Effect.Effect<void, never, DigestEnv> =>
        Effect.gen(function* () {
          const settings = yield* settingsFor(sessionId)
          if (
            settings === null ||
            !settings.auto ||
            settings.session.cli !== "codex" ||
            settings.session.resumeId === null
          ) {
            return
          }
          const state = yield* stateOf(sessionId)
          const persisted = settings.session.contextTokens ?? 0
          if (state.tokens > 0 || persisted > 0 || state.status === "ready") return

          const messages = yield* TranscriptStore.list(sessionId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          let chars = 0
          for (const message of messages) {
            chars += JSON.stringify(message).length
            if (chars >= UNKNOWN_CODEX_TRANSCRIPT_RECOVERY_CHARS) {
              yield* compactNow(sessionId, { waitForReady: true })
              return
            }
          }
        })

      /**
       * The structural half of the mid-flow question, which no summary can see.
       *
       * These are facts about the session's CURRENT state rather than its
       * narrative: a plan the agent is still executing, a question the user never
       * answered, a gate waiting on approval, a background task still running.
       * Each one means the next turn is a continuation, and a continuation that
       * starts from a summary has lost the thing it was continuing.
       *
       * Best-effort in every branch — a transcript read that fails must not take
       * the turn down with it, it just means we don't hold.
       */
      const midFlowLocally = (
        sessionId: string
      ): Effect.Effect<
        boolean,
        never,
        TranscriptStore | BackgroundTaskStore | FileSystem.FileSystem | Path.Path | AppPaths
      > =>
        Effect.gen(function* () {
          const tasks = yield* BackgroundTaskStore.list(sessionId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<BackgroundTask>)
          )
          if (tasks.some((t) => t.status === "running" || t.status === "stopping")) return true

          const messages = yield* TranscriptStore.list(sessionId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          const last = messages.at(-1)
          if (last === undefined) return false
          return last.parts.some(
            (p) =>
              // A plan awaiting the operator, or an approved one still working
              // through its steps — both mean the next turn is a continuation.
              (p._tag === "Plan" &&
                (p.plan.status === "proposed" ||
                  p.plan.status === "revising" ||
                  (p.plan.status === "approved" &&
                    p.plan.steps.some((s) => s.status !== "done")))) ||
              (p._tag === "Question" && p.answers === null) ||
              (p._tag === "Gate" && p.gate.status === "pending")
          )
        })

      /**
       * Consume a ready digest, if there is one. Called at the top of a turn.
       *
       * Returns the digest exactly once — the state flips to idle in the same
       * update — so a swap can never be applied twice, which would reseed a fresh
       * conversation with a summary of the conversation it just replaced.
       *
       * `tokensBefore` is the occupancy the swap happened AT, reported so the
       * transcript marker can say "compacted from 290k". It is read here, from
       * this service's own `Usage`-fed reading, precisely because the caller's
       * obvious alternative — `Session.tokens` — is the session's LIFETIME total
       * and rendered as "compacted from 49894.2k" on a long-running session.
       */
      const applyIfReady = (
        sessionId: string
      ): Effect.Effect<
        { digest: ContextDigest; tokensBefore: number } | null,
        never,
        | SessionStore
        | TranscriptStore
        | BackgroundTaskStore
        | FileSystem.FileSystem
        | Path.Path
        | AppPaths
      > =>
        Effect.gen(function* () {
          const state = yield* stateOf(sessionId)
          if (state.status !== "ready" || state.digest === null) return null
          const at = yield* Effect.sync(() => new Date().toISOString())
          const session = yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
          const tokensBefore = state.tokens > 0 ? state.tokens : session?.contextTokens ?? 0

          // Would swapping RIGHT NOW cost more than it saves? The digest is not
          // discarded when it would — it stays ready and is re-offered next turn,
          // so a hold costs one turn of extra context and nothing else.
          // A forced recovery has no usable old conversation to preserve. The
          // normal mid-flow hold is valuable for proactive/background digests,
          // but applying it after a hard overflow (or an unsafe legacy resume)
          // sends the next turn straight back to the already-dead vendor thread.
          const hold =
            !state.waitForReady &&
            shouldHoldSwap({
              // Absent means the digest predates the verdict (or the model omitted
              // it): "we don't know" must never hold a session open.
              midFlow: state.digest.midFlow ?? false,
              localHold: yield* midFlowLocally(sessionId),
              tokens: tokensBefore,
              window:
                state.window ?? contextWindowFor(session?.cli ?? "claude", session?.model ?? null),
              deferrals: state.deferrals
            })
          if (hold) {
            const reason =
              state.digest.midFlowReason ?? "the session is in the middle of something"
            yield* setState(sessionId, (s) => ({
              ...s,
              deferrals: s.deferrals + 1,
              heldReason: reason
            }))
            return null
          }

          yield* setState(sessionId, (s) => ({
            ...s,
            status: "idle",
            digest: null,
            waitForReady: false,
            // The reseed starts a NEW harness conversation, so the reading that
            // described the old one is not merely stale — it is about a
            // conversation that no longer exists. Leaving it in place made the
            // meter read "compacting soon" over a 40k session and made the very
            // next `settle` fork a second digest against the pre-swap number.
            tokens: 0,
            failures: 0,
            compactions: s.compactions + 1,
            lastCompactedAt: at,
            deferrals: 0,
            heldReason: null
          }))
          // The persisted copy is what `settle` and `snapshot` fall back to when
          // no live reading has arrived yet, so clearing only the in-memory one
          // would let the stale number come straight back on the next turn.
          yield* SessionStore.setContextTokens(sessionId, 0).pipe(Effect.ignore)
          return { digest: state.digest, tokensBefore }
        })

      /**
       * Consume a digest, waiting when its background build is already running.
       *
       * The ordinary path remains instant: idle and ready states return on the
       * first inspection. Waiting matters after a context-overflow failure,
       * where the recovery digest starts at turn end and an immediate retry
       * would otherwise resume the same full harness thread before that digest
       * became ready.
       */
      const applyWhenReady = (
        sessionId: string
      ): Effect.Effect<
        { digest: ContextDigest; tokensBefore: number } | null,
        never,
        | SessionStore
        | TranscriptStore
        | BackgroundTaskStore
        | FileSystem.FileSystem
        | Path.Path
        | AppPaths
      > =>
        Effect.gen(function* () {
          for (;;) {
            const state = yield* stateOf(sessionId)
            if (state.status === "ready") return yield* applyIfReady(sessionId)
            if (state.status !== "preparing" || !state.waitForReady) return null
            yield* Effect.sleep("100 millis")
          }
        }).pipe(
          // The digest run itself is bounded at 90s. This outer guard covers
          // setup/teardown too and prevents a broken background path from
          // parking the operator's next turn forever.
          Effect.timeout("95 seconds"),
          Effect.orElseSucceed(() => null)
        )

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
          yield* setState(sessionId, (s) => ({
            ...s,
            status: "idle",
            digest: null,
            waitForReady: false
          }))
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
            stalled: state.failures >= MAX_FAILURES,
            // A held swap still has its digest, so `digestReady` stays true; this
            // is what stops the meter promising "compacts next turn" every turn.
            held: state.digest !== null && state.deferrals > 0,
            heldReason: state.deferrals > 0 ? state.heldReason : null
          }
        })

      return {
        observe,
        settle,
        applyIfReady,
        applyWhenReady,
        compactNow,
        prepareUnknownCodexResume,
        cancel,
        snapshot
      }
    })
  }
) {}
