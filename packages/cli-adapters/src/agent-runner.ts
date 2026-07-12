import type {
  ApprovalGate,
  GateDecision,
  PermissionMode,
  Session,
  StreamEvent
} from "@starbase/core"
import { applyStreamEvent, assistantMessage, defaultModel, userMessage } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Deferred, Effect, Mailbox, Ref, Stream } from "effect"
import { AppPaths } from "./app-paths.js"
import { CliAdapter } from "./adapter.js"
import type { PermissionDecision, PermissionRequest, SessionSpec } from "./adapter.js"
import { DiscoveryService } from "./discovery.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"

/** A gate awaiting the operator; the `Deferred` unblocks the paused agent. */
interface PendingGate {
  readonly sessionId: string
  readonly deferred: Deferred.Deferred<PermissionDecision>
  /** Token added to the session allowlist on an "always" decision. */
  readonly allowLabel: string | null
}

/** The first two words of a command — the "Always allow …" token, e.g. "npm test". */
const allowLabelOf = (command: string): string => command.trim().split(/\s+/).slice(0, 2).join(" ")

const isAllowlisted = (allow: ReadonlySet<string>, command: string | null): boolean =>
  command !== null && [...allow].some((a) => command === a || command.startsWith(`${a} `))

const basename = (target: string | null): string => target?.split("/").pop() ?? "file"

/**
 * Decide whether a requested action runs (`"allow"`) or must pause for the
 * operator (`"gate"`), from the session's HITL mode + allowlist:
 * - `auto` — everything runs,
 * - `accept-edits` — edits run, commands gate (unless allowlisted),
 * - `ask` — edits and commands both gate (unless a command is allowlisted).
 */
const verdict = (
  mode: PermissionMode,
  allow: ReadonlySet<string>,
  req: PermissionRequest
): "allow" | "gate" => {
  if (mode === "auto") return "allow"
  if (isAllowlisted(allow, req.command)) return "allow"
  if (req.kind === "edit") return mode === "accept-edits" ? "allow" : "gate"
  return "gate"
}

const buildGate = (id: string, req: PermissionRequest): ApprovalGate =>
  req.kind === "command"
    ? {
        id,
        kind: "command",
        title: "Approval needed · run a command",
        detail:
          "Not in your allowlist. Agents never run shell commands until you allow — any file edits above were applied under this mode.",
        command: req.command,
        allowLabel: req.command ? allowLabelOf(req.command) : null,
        status: "pending"
      }
    : {
        id,
        kind: "edit",
        title: `Approval needed · edit ${basename(req.target)}`,
        detail: "Review the change above, then approve to write it to disk.",
        command: null,
        allowLabel: null,
        status: "pending"
      }

type PromptEnv =
  | CliAdapter
  | SessionStore
  | TranscriptStore
  | DiscoveryService
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

/**
 * Orchestrates a prompt against the selected harness. `prompt` returns a
 * `Stream<StreamEvent>` — the harness-agnostic seam the renderer subscribes to —
 * while, in-band, it applies the session's HITL mode, pauses on gates, folds each
 * event into the persisted transcript, and re-emits it. Gate/mode state lives in
 * this singleton service so `decideGate`/`setMode` (separate RPCs) can reach the
 * paused run.
 */
export class AgentRunner extends Effect.Service<AgentRunner>()("@starbase/AgentRunner", {
  effect: Effect.gen(function* () {
    // gateId → the pending gate (shared across prompt/decideGate/stop calls).
    const gates = yield* Ref.make(new Map<string, PendingGate>())
    // Per-session live HITL state, seeded from the Session record on first use.
    const modes = yield* Ref.make(new Map<string, PermissionMode>())
    const allowlists = yield* Ref.make(new Map<string, Set<string>>())
    // Monotonic id source — deterministic (no Date.now/random) for stable tests.
    const counter = yield* Ref.make(0)
    const nextId = Ref.updateAndGet(counter, (n) => n + 1)

    const persistMode = (sessionId: string, mode: PermissionMode) =>
      SessionStore.setMode(sessionId, mode).pipe(Effect.ignore)

    const setMode = (sessionId: string, mode: PermissionMode) =>
      Ref.update(modes, (m) => new Map(m).set(sessionId, mode)).pipe(
        Effect.zipRight(persistMode(sessionId, mode))
      )

    const decideGate = (sessionId: string, gateId: string, decision: GateDecision) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(gates)).get(gateId)
        if (entry === undefined || entry.sessionId !== sessionId) return
        if (decision === "always" && entry.allowLabel !== null) {
          const label = entry.allowLabel
          yield* Ref.update(allowlists, (m) => {
            const next = new Map(m)
            const set = new Set(next.get(sessionId) ?? [])
            set.add(label)
            next.set(sessionId, set)
            return next
          })
          yield* SessionStore.addAllowlist(sessionId, label).pipe(Effect.ignore)
        }
        yield* Deferred.succeed(entry.deferred, decision === "deny" ? "deny" : "allow")
      })

    /** Deny every pending gate for a session — a graceful stop of a paused run. */
    const stop = (sessionId: string) =>
      Effect.gen(function* () {
        const all = yield* Ref.get(gates)
        yield* Effect.forEach(
          [...all.values()].filter((g) => g.sessionId === sessionId),
          (g) => Deferred.succeed(g.deferred, "deny"),
          { discard: true }
        )
      })

    const prompt = (sessionId: string, text: string): Stream.Stream<StreamEvent, never, PromptEnv> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const adapter = yield* CliAdapter
          const session: Session | null = yield* SessionStore.get(sessionId).pipe(
            Effect.map((s): Session | null => s),
            Effect.orElseSucceed(() => null)
          )

          const mode = (yield* Ref.get(modes)).get(sessionId) ?? session?.mode ?? "accept-edits"
          const allow = new Set<string>([
            ...((yield* Ref.get(allowlists)).get(sessionId) ?? []),
            ...(session?.allowlist ?? [])
          ])
          const cli = session?.cli ?? "claude"
          // Resolve the harness binary; null → the dispatcher uses the scripted
          // fallback (also the path when the CLI isn't installed).
          const binPath =
            (yield* DiscoveryService.list().pipe(Effect.orElseSucceed(() => [])))
              .find((c) => c.kind === cli)?.binPath ?? null
          const spec: SessionSpec = {
            cli,
            repo: session?.repo ?? "",
            branch: session?.branch ?? "",
            cwd: session?.worktreePath ?? "",
            prompt: text,
            binPath,
            mode,
            model: session?.model ?? defaultModel(cli)
          }

          // Capture the persistence services so `emit`/`run` handed to the
          // adapter have no residual requirements (R = never).
          const env = yield* Effect.context<
            TranscriptStore | SessionStore | FileSystem.FileSystem | Path.Path | AppPaths
          >()

          const now = yield* Effect.sync(() => new Date().toISOString())
          // The id counter is in-memory and resets when the app restarts, but the
          // transcript persists — so seed it past any id already recorded for this
          // session, otherwise a run after a restart re-emits colliding ids
          // (`u_<sid>_1`, `a_<sid>_2`, …) and the virtualized transcript stacks
          // rows keyed by those ids. Deterministic: empty transcript → starts at 1.
          const priorMax = (yield* TranscriptStore.list(sessionId).pipe(Effect.orElseSucceed(() => [])))
            .reduce((max, m) => {
              const n = Number(m.id.split("_").pop())
              return Number.isFinite(n) && n > max ? n : max
            }, 0)
          yield* Ref.update(counter, (c) => Math.max(c, priorMax))
          const un = yield* nextId
          yield* TranscriptStore.append(sessionId, userMessage(`u_${sessionId}_${un}`, text, now))
          const an = yield* nextId
          const acc = yield* Ref.make(assistantMessage(`a_${sessionId}_${an}`, now))
          yield* TranscriptStore.append(sessionId, yield* Ref.get(acc))

          const out = yield* Mailbox.make<StreamEvent>()

          // Fold each event into the assistant message + persist, then surface it.
          // Runs on the single producer fiber, so transcript order is preserved.
          const emit = (event: StreamEvent): Effect.Effect<void> =>
            Effect.gen(function* () {
              const next = applyStreamEvent(yield* Ref.get(acc), event)
              yield* Ref.set(acc, next)
              yield* TranscriptStore.patchLast(sessionId, () => next).pipe(Effect.ignore)
              // Persist the harness's actual model (reported on init) so the chip
              // reflects reality even when the session hadn't pinned one.
              if (event._tag === "Started" && event.model) {
                yield* SessionStore.setModel(sessionId, event.model).pipe(Effect.ignore)
              }
              yield* out.offer(event)
            }).pipe(Effect.provide(env), Effect.asVoid)

          const canUseTool = (req: PermissionRequest): Effect.Effect<PermissionDecision> =>
            Effect.gen(function* () {
              if (verdict(mode, allow, req) === "allow") return "allow" as const
              const gn = yield* nextId
              const gateId = `g_${sessionId}_${gn}`
              const gate = buildGate(gateId, req)
              const deferred = yield* Deferred.make<PermissionDecision>()
              yield* Ref.update(gates, (m) =>
                new Map(m).set(gateId, { sessionId, deferred, allowLabel: gate.allowLabel })
              )
              yield* emit({ _tag: "GateRequested", gate })
              const decision = yield* Deferred.await(deferred)
              yield* Ref.update(gates, (m) => {
                const next = new Map(m)
                next.delete(gateId)
                return next
              })
              return decision
            })

          const run = adapter.run(sessionId, spec, { emit, canUseTool }).pipe(
            Effect.catchAllCause(() => emit({ _tag: "Failed", message: "The agent run failed." })),
            Effect.ensuring(out.end)
          )
          yield* Effect.forkScoped(run)
          return Mailbox.toStream(out)
        })
      )

    return { prompt, decideGate, setMode, stop } as const
  })
}) {}
