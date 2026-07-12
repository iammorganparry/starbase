import type {
  CliKind,
  PermissionMode,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent
} from "@starbase/core"
import { CliExecError } from "@starbase/core"
import { Context, Effect, Layer } from "effect"

/** Parameters for starting a new agent turn against a CLI. */
export interface SessionSpec {
  readonly cli: CliKind
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly prompt: string
  /** Resolved path to the harness binary, or null when it isn't installed. */
  readonly binPath: string | null
  /** The session's HITL permission mode (drives the harness's permission mode). */
  readonly mode: PermissionMode
  /** The model id to run, or null to use the harness default. */
  readonly model: string | null
}

/** What the agent is asking permission to do, surfaced before it acts. */
export interface PermissionRequest {
  readonly kind: "command" | "edit"
  /** Tool name, e.g. "Edit" or "Bash". */
  readonly tool: string
  readonly target: string | null
  /** The shell command awaiting approval, when `kind === "command"`. */
  readonly command: string | null
}

export type PermissionDecision = "allow" | "deny"

/**
 * A permission resolver the adapter calls before any gated action. The
 * `AgentRunner` supplies one that applies the session's HITL mode/allowlist and,
 * when it must pause, emits an approval gate and awaits the operator. Mirrors the
 * real `claude -p` `canUseTool` callback, keeping the adapter harness-agnostic.
 */
export type CanUseTool = (req: PermissionRequest) => Effect.Effect<PermissionDecision>

/**
 * Present a group of structured questions to the user and await the answers
 * (mirrors the SDK's AskUserQuestion tool). The `AgentRunner` supplies one that
 * emits a `QuestionRequested` event and parks until the user submits.
 */
export type AskQuestion = (
  request: QuestionRequest
) => Effect.Effect<ReadonlyArray<QuestionAnswer>>

/**
 * What the adapter is handed for a run: an ordered `emit` sink for normalized
 * events, the `canUseTool` gate, and `askQuestion` for structured input. Because
 * the adapter drives a single fiber that interleaves these in program order, the
 * transcript order (where a gate/question lands) is deterministic.
 */
export interface AgentContext {
  readonly emit: (event: StreamEvent) => Effect.Effect<void>
  readonly canUseTool: CanUseTool
  readonly askQuestion: AskQuestion
}

/**
 * The contract for wrapping a native coding CLI. A real headless adapter
 * (`claude -p --output-format stream-json`, codex/cursor equivalents) parses its
 * CLI's stream into normalized `StreamEvent`s (via `ctx.emit`) and calls
 * `ctx.canUseTool` before gated actions. Everything downstream (persistence, UI)
 * only sees `StreamEvent`, so the experience is identical across harnesses.
 */
export interface CliAdapterShape {
  readonly run: (
    sessionId: string,
    spec: SessionSpec,
    ctx: AgentContext
  ) => Effect.Effect<void, CliExecError>
  readonly stop: (sessionId: string) => Effect.Effect<void, CliExecError>
}

export class CliAdapter extends Context.Tag("@starbase/CliAdapter")<
  CliAdapter,
  CliAdapterShape
>() {}

/**
 * The scripted run body — a deterministic sequence (thinking, reads, a gated
 * edit, a gated shell command) driving the full contract without a real process.
 * Reused by both `makeScriptedCliAdapter`'s Layer and the harness dispatcher's
 * fallback (tests / e2e / no-CLI-installed). `delayMs` paces the stream.
 */
export const scriptedRun =
  (delayMs: number): CliAdapterShape["run"] =>
  (sessionId, spec, { emit, canUseTool, askQuestion }) =>
    Effect.gen(function* () {
      const pause = delayMs > 0 ? Effect.sleep(`${delayMs} millis`) : Effect.void

      yield* emit({ _tag: "Started", sessionId })
      yield* pause

      // A `[[ask]]` marker in the prompt drives the AskUserQuestion flow (used by
      // the question e2e/tests) instead of the default gated edit/command flow.
      if (spec.prompt.includes("[[ask]]")) {
        yield* emit({
          _tag: "Thinking",
          text: "Before I start I need a couple of decisions.",
          seconds: 2,
          done: true
        })
        yield* pause
        const answers = yield* askQuestion({
          id: `q_${sessionId}`,
          questions: [
            {
              question: "Which token strategy should the store use?",
              header: "Strategy",
              multiSelect: false,
              options: [
                { label: "Rotating refresh tokens", description: "New refresh token on every use — most secure." },
                { label: "Sliding session", description: "Extend expiry on activity, single long-lived token." },
                { label: "Short-lived access + refresh", description: "15-min access, 7-day refresh. The common default." }
              ]
            },
            {
              question: "Which surfaces should adopt the new store?",
              header: "Surfaces",
              multiSelect: true,
              options: [
                { label: "HTTP middleware", description: "Express session guard on the API." },
                { label: "WebSocket handshake", description: "Auth on the realtime channel." },
                { label: "Background workers", description: "Queue consumers acting on a user's behalf." }
              ]
            }
          ]
        })
        const summary = answers
          .map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(", ") || "—")
          .join(" · ")
        yield* emit({ _tag: "Assistant", text: `Got it — starting with: ${summary}.` })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }
      yield* emit({ _tag: "Thinking", text: "No limiter middleware exists yet. ", seconds: null, done: false })
      yield* pause
      yield* emit({
        _tag: "Thinking",
        text: "I'll reuse the token-bucket in lib/ratelimit.ts, apply it to POST /refund, then add a 429 test.",
        seconds: 6,
        done: true
      })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "read-1", name: "Read", target: "src/routes/billing.ts" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "read-1", status: "success", meta: "142 lines", diff: null, preview: null })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "grep-1", name: "Grep", target: "rateLimit|tokenBucket" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "grep-1", status: "success", meta: "0 hits", diff: null, preview: null })
      yield* pause
      yield* emit({
        _tag: "Assistant",
        text: "No limiter is wired up. Adding the middleware to the refund route and a matching test."
      })
      yield* pause

      // ── Edit (gated on `kind === "edit"`) ──
      const editDecision = yield* canUseTool({
        kind: "edit",
        tool: "Edit",
        target: "src/routes/billing.ts",
        command: null
      })
      if (editDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "edit-1", name: "Edit", target: "src/routes/billing.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "edit-1",
          status: "success",
          meta: null,
          diff: { added: 7, removed: 0 },
          preview: "61  + router.post('/refund', rateLimit(5, '1m'), requireAuth, refundHandler)"
        })
      } else {
        yield* emit({ _tag: "Assistant", text: "Holding the edit until you approve it." })
      }
      yield* pause

      // ── Shell command (gated on `kind === "command"`) ──
      const cmdDecision = yield* canUseTool({
        kind: "command",
        tool: "Bash",
        target: "npm test -- billing",
        command: "npm test -- billing"
      })
      if (cmdDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "bash-1", name: "Bash", target: "npm test -- billing" })
        yield* pause
        yield* emit({ _tag: "ToolEnd", id: "bash-1", status: "success", meta: "1 passed", diff: null, preview: null })
      } else {
        yield* emit({ _tag: "Assistant", text: "Left the tests unrun for now." })
      }
      yield* pause
      yield* emit({ _tag: "Done", costUsd: 0.38, tokens: 42_100 })
    })

/**
 * A deterministic adapter driving the full contract without a real process —
 * the tests/e2e/fallback path. `delayMs` paces the stream.
 */
export const makeScriptedCliAdapter = (delayMs: number): Layer.Layer<CliAdapter> =>
  Layer.succeed(CliAdapter, CliAdapter.of({ run: scriptedRun(delayMs), stop: () => Effect.void }))

/** The default scripted adapter, paced for a visible streaming cadence. */
export const ScriptedCliAdapterLive = makeScriptedCliAdapter(320)
