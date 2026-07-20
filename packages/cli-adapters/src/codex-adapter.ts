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

/**
 * Tokens occupying Codex's context window after a completed turn.
 *
 * A Codex turn resends the whole thread, so the turn's `input_tokens` IS the
 * conversation as the model saw it; adding the reply gives the size the next
 * turn inherits. That makes this the direct analogue of Claude's
 * `contextTokens`, despite arriving through a completely different event.
 *
 * The two subset fields are deliberately NOT added:
 *  - `cached_input_tokens` is part of `input_tokens` (codex itself derives
 *    non-cached input by subtracting it), and
 *  - `reasoning_output_tokens` is part of `output_tokens`.
 * Summing all four double-counts both, inflating the reading by roughly the
 * cache-hit rate — which on a long, heavily-cached session is most of it. That
 * error is in the "compact far too early" direction, so it would have looked
 * like a working feature while quietly halving everyone's usable context.
 *
 * This replaces a hard-coded `0`. The old comment was right that a turn TOTAL
 * mislabelled as context is worse than no number — but `input + output` is not
 * a turn total, it is the context, and without it Codex sessions could never
 * participate in auto-compaction at all.
 */
export const codexContextTokens = (usage: {
  readonly input_tokens?: number
  readonly output_tokens?: number
  /** Subset of `input_tokens` — accepted so the real payload type-checks, never summed. */
  readonly cached_input_tokens?: number
  /** Subset of `output_tokens` — accepted so the real payload type-checks, never summed. */
  readonly reasoning_output_tokens?: number
}): number => {
  const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  return num(usage?.input_tokens) + num(usage?.output_tokens)
}

/**
 * Which Codex thread a run should continue, or `undefined` to start a new one.
 *
 * Extracted as a pure function because the branch that matters cannot be reached
 * without a real Codex login otherwise — and it was wrong: `fresh` was ignored
 * here while Claude and opencode honoured it, so every one-shot caller silently
 * resumed the thread it was trying to escape.
 */
export const threadIdFor = (input: {
  readonly resume: ReadonlyMap<string, string>
  readonly sessionId: string
  readonly resumeId?: string | null
  readonly fresh?: boolean
}): string | undefined => {
  if (input.fresh === true) return undefined
  return input.resume.get(input.sessionId) ?? input.resumeId ?? undefined
}

/**
 * Record the thread id a run just started, unless the run was `fresh`.
 *
 * A one-shot run must leave no trace, or the NEXT turn under the same session id
 * resumes it — which would make a compaction's throwaway thread the session's
 * real one.
 */
export const rememberThread = (input: {
  readonly resume: Map<string, string>
  readonly sessionId: string
  readonly threadId: string
  readonly fresh?: boolean
}): void => {
  if (input.fresh === true) return
  input.resume.set(input.sessionId, input.threadId)
}

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

    case "turn.completed": {
      const tokens = codexContextTokens(event.usage)
      return [
        { _tag: "Usage", tokens },
        { _tag: "Done", costUsd: 0, tokens }
      ]
    }

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
        //
        // `fresh` opts out of BOTH, and must: the map wins over `spec.resumeId`,
        // so clearing the persisted id alone leaves a caller that asked for a
        // brand-new thread silently resuming the old one. Two callers depend on
        // this — the adversarial reviewer (which must be a pure function of the
        // diff) and context compaction (whose entire purpose is to shed the
        // thread it just summarised). Claude and opencode already honoured it;
        // Codex was the odd one out, so on Codex both features quietly no-opped
        // while still paying for the run.
        const prior = threadIdFor({ resume, sessionId, resumeId: spec.resumeId, fresh: spec.fresh })
        const thread = prior
          ? codex.resumeThread(prior, threadOptions)
          : codex.startThread(threadOptions)

        const { events } = await thread.runStreamed(spec.prompt, { signal: abort.signal })
        for await (const event of events) {
          if (event.type === "thread.started" && event.thread_id) {
            rememberThread({ resume, sessionId, threadId: event.thread_id, fresh: spec.fresh })
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
