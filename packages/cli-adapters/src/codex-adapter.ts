import type { PermissionMode, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { ApprovalMode, SandboxMode, ThreadEvent } from "@openai/codex-sdk"
import { Effect, Runtime } from "effect"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { capOutput } from "./output-cap.js"
import { requireWorktree } from "./cwd.js"
import { harnessEnv, hasSubscriptionAuth } from "./subscription.js"

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
 *
 * `readOnly` overrides the mode entirely. It has to be enforced HERE, in the
 * sandbox, because this adapter never calls `ctx.canUseTool` — so a caller that
 * denies every gated action (the adversarial reviewer) gets no protection at all
 * from that callback, and would otherwise run `workspace-write` + approval
 * `never`, i.e. free rein over the worktree it was told not to touch.
 */
export const mapCodexPolicy = (
  mode: PermissionMode,
  readOnly = false,
  /**
   * Nobody is watching this run. Caps the policy at `workspace-write` however
   * permissive the session's mode is: `danger-full-access` is a reasonable thing
   * for an operator to choose for a session they are supervising, and an
   * indefensible thing to inherit silently for a planning role or a plan step.
   */
  unattended = false
): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } =>
  readOnly
    ? { sandboxMode: "read-only", approvalPolicy: "never" }
    : mode === "auto" && !unattended
      ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
      : { sandboxMode: "workspace-write", approvalPolicy: "never" }

/** Fold one Codex `ThreadEvent` into our normalized `StreamEvent`s. */
export const codexEventToStreamEvents = (
  event: ThreadEvent,
  sessionId: string
): ReadonlyArray<StreamEvent> => {
  switch (event.type) {
    case "thread.started":
      // Carry Codex's OWN thread id (not the Starbase session key) so the runner
      // persists it as the resume id and "continue" reloads the thread after a
      // restart. Falls back to the Starbase key if the thread id is absent.
      return [{ _tag: "Started", sessionId: event.thread_id || sessionId }]

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

    // When codex emits a mid-run update, it reprints the command's aggregated
    // stdout+stderr so far — stream it as live output so the card fills as it runs
    // rather than staying blank until exit. Snapshot semantics (`aggregated_output`
    // is the whole output, not a chunk) match `ToolDelta`'s idempotent fold, so a
    // skipped update never corrupts the text; empty updates carry no card change.
    //
    // NOTE: whether codex emits `item.updated` for a running command is
    // VERSION-DEPENDENT — some CLI builds go straight from `item.started` to
    // `item.completed` with nothing in between (observed live). This maps the
    // updates when they DO arrive; when they don't, the card fills whole from the
    // `ToolEnd.output` below. Either way no output is lost.
    case "item.updated": {
      const it = event.item
      if (it.type !== "command_execution" || it.aggregated_output.length === 0) return []
      return [{ _tag: "ToolDelta", id: it.id, output: capOutput(it.aggregated_output) }]
    }

    case "item.completed": {
      const it = event.item
      switch (it.type) {
        case "agent_message":
          return [{ _tag: "Assistant", text: it.text }]
        case "reasoning":
          return [{ _tag: "Thinking", text: it.text, seconds: null, done: true }]
        case "command_execution": {
          // codex carries the command's output in `aggregated_output` (it fills
          // NEITHER a separate output nor a preview field). Persist it as the
          // tool's authoritative output so the card — and the bash widgets, which
          // read `output` — show what actually ran, and so a reload matches the
          // live view built up from the deltas above.
          const output = it.aggregated_output.length > 0 ? capOutput(it.aggregated_output) : undefined
          return [
            {
              _tag: "ToolEnd",
              id: it.id,
              status: it.status === "failed" ? "error" : "success",
              meta: it.exit_code != null ? `exit ${it.exit_code}` : null,
              diff: null,
              preview: null,
              ...(output !== undefined ? { output } : {})
            }
          ]
        }
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
          // The exec SDK exposes aggregate turn consumption, not the current
          // thread context size. Zero means "unavailable" to the renderer; a
          // turn total labelled as context would be worse than no number.
          tokens: 0
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
        const codex = new Codex({
          codexPathOverride: spec.binPath ?? undefined,
          // Run on the operator's ChatGPT plan where they have one. The SDK does
          // not inherit `process.env` when this is given, so it is a complete
          // copy minus the metered key. See `subscription.ts`.
          env: harnessEnv("codex", process.env, hasSubscriptionAuth("codex"))
        })
        const threadOptions = {
          // See `requireWorktree`: inheriting the app's cwd would run this
          // session against an unrelated repository.
          workingDirectory: requireWorktree(spec.cwd, `session ${sessionId}`),
          skipGitRepoCheck: true,
          ...(spec.model ? { model: spec.model } : {}),
          ...mapCodexPolicy(spec.mode, spec.readOnly ?? false, spec.unattended ?? false)
        }
        // Prefer the live in-memory thread id (this launch), else the id persisted
        // on the session (survives an app restart), so "continue" resumes the
        // Codex thread instead of starting a fresh one.
        const prior = resume.get(sessionId) ?? spec.resumeId ?? undefined
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
