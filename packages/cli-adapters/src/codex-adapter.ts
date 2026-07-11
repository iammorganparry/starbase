import type { PermissionMode, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { ApprovalMode, SandboxMode, ThreadEvent } from "@openai/codex-sdk"
import { Effect, Runtime } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"

/**
 * Real Codex harness, driven by `@openai/codex-sdk`. Codex's exec model is
 * autonomous: unlike Claude there is no per-tool `canUseTool` callback, so HITL
 * is coarse — our mode maps onto Codex's `sandboxMode` + `approvalPolicy` at
 * thread start (per-command gating is a follow-up via the app-server protocol).
 * The `ThreadEvent` → `StreamEvent` mapping is pure and unit-tested; `runCodex`
 * is verified live.
 */

// ── Pure mapping helpers (the testable seam) ─────────────────────────────────

/**
 * Map our HITL mode onto Codex's sandbox + approval policy. Approval stays
 * `never` (there is no interactive callback in exec mode); the mode instead
 * widens the sandbox — `auto` gets full access, otherwise edits/commands are
 * confined to the workspace.
 */
export const mapCodexPolicy = (
  mode: PermissionMode
): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } =>
  mode === "auto"
    ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
    : { sandboxMode: "workspace-write", approvalPolicy: "never" }

/** Fold one Codex `ThreadEvent` into our normalized `StreamEvent`s. */
export const codexEventToStreamEvents = (
  event: ThreadEvent,
  sessionId: string
): ReadonlyArray<StreamEvent> => {
  switch (event.type) {
    case "thread.started":
      return [{ _tag: "Started", sessionId }]

    case "item.started": {
      const it = event.item
      if (it.type === "command_execution")
        return [{ _tag: "ToolStart", id: it.id, name: "Bash", target: it.command }]
      if (it.type === "file_change")
        return [{ _tag: "ToolStart", id: it.id, name: "Edit", target: it.changes[0]?.path ?? null }]
      if (it.type === "web_search")
        return [{ _tag: "ToolStart", id: it.id, name: "WebSearch", target: it.query }]
      if (it.type === "mcp_tool_call")
        return [{ _tag: "ToolStart", id: it.id, name: it.tool, target: it.server }]
      return []
    }

    case "item.completed": {
      const it = event.item
      switch (it.type) {
        case "agent_message":
          return [{ _tag: "Assistant", text: it.text }]
        case "reasoning":
          return [{ _tag: "Thinking", text: it.text, seconds: null, done: true }]
        case "command_execution":
          return [
            {
              _tag: "ToolEnd",
              id: it.id,
              status: it.status === "failed" ? "error" : "success",
              meta: it.exit_code != null ? `exit ${it.exit_code}` : null,
              diff: null,
              preview: null
            }
          ]
        case "file_change":
          return [
            {
              _tag: "ToolEnd",
              id: it.id,
              status: it.status === "failed" ? "error" : "success",
              meta: `${it.changes.length} file${it.changes.length === 1 ? "" : "s"}`,
              diff: null,
              preview: null
            }
          ]
        case "web_search":
          return [{ _tag: "ToolEnd", id: it.id, status: "success", meta: null, diff: null, preview: null }]
        case "mcp_tool_call":
          return [
            {
              _tag: "ToolEnd",
              id: it.id,
              status: it.status === "failed" ? "error" : "success",
              meta: null,
              diff: null,
              preview: null
            }
          ]
        case "error":
          return [{ _tag: "Assistant", text: it.message }]
        default:
          return []
      }
    }

    case "turn.completed":
      return [
        {
          _tag: "Done",
          costUsd: 0,
          tokens: event.usage.input_tokens + event.usage.output_tokens
        }
      ]

    case "turn.failed":
      return [{ _tag: "Failed", message: event.error.message }]

    case "error":
      return [{ _tag: "Failed", message: event.message }]

    default:
      return []
  }
}

// ── The live adapter ─────────────────────────────────────────────────────────

/**
 * Run one Codex turn in the session's worktree. Streams normalized events via
 * `ctx.emit` and stores the thread id in `resume` for multi-turn continuation.
 * `ctx.canUseTool` is unused (Codex has no per-tool callback — see the mode
 * mapping above). Interrupting the Effect aborts the run.
 */
export const runCodex = (
  sessionId: string,
  spec: SessionSpec,
  ctx: AgentContext,
  resume: Map<string, string>
): Effect.Effect<void, CliExecError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runP = <A>(effect: Effect.Effect<A>): Promise<A> => Runtime.runPromise(runtime)(effect)
    const abort = new AbortController()

    yield* Effect.tryPromise({
      try: async () => {
        const { Codex } = await import("@openai/codex-sdk")
        const codex = new Codex({ codexPathOverride: spec.binPath ?? undefined })
        const threadOptions = {
          workingDirectory: spec.cwd || undefined,
          skipGitRepoCheck: true,
          ...mapCodexPolicy(spec.mode)
        }
        const prior = resume.get(sessionId)
        const thread = prior
          ? codex.resumeThread(prior, threadOptions)
          : codex.startThread(threadOptions)

        const { events } = await thread.runStreamed(spec.prompt, { signal: abort.signal })
        for await (const event of events) {
          if (event.type === "thread.started" && event.thread_id) {
            resume.set(sessionId, event.thread_id)
          }
          for (const se of codexEventToStreamEvents(event, sessionId)) {
            await runP(ctx.emit(se))
          }
        }
      },
      catch: (cause) =>
        new CliExecError({
          kind: spec.cli,
          message: cause instanceof Error ? cause.message : String(cause)
        })
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => abort.abort())))
  })
