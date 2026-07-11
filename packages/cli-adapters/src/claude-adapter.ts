import type { DiffStat, PermissionMode, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { PermissionMode as SdkPermissionMode, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Runtime } from "effect"
import type { AgentContext, PermissionRequest, SessionSpec } from "./adapter.js"

/**
 * Real Claude harness, driven by `@anthropic-ai/claude-agent-sdk`'s `query()`.
 * The adapter parses the SDK's message stream into our normalized `StreamEvent`s
 * (via `ctx.emit`) and bridges the SDK's `canUseTool` onto our `CanUseTool`, so
 * the transcript, HITL machine and UI never know which harness ran. The mapping
 * functions are pure and unit-tested against SDK-message fixtures; `runClaude`
 * itself is verified live (needs the user's `claude` login).
 */

// ── Pure mapping helpers (the testable seam) ─────────────────────────────────

const strOf = (v: unknown): string | null => (typeof v === "string" ? v : null)
const numOf = (v: unknown): number => (typeof v === "number" ? v : 0)

/** Tools that write to disk — gated as "edit" and carry a diff peek. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"])
export const isEditTool = (name: string): boolean => EDIT_TOOLS.has(name)

/** Map our HITL mode onto the SDK's permission mode. */
export const mapPermissionMode = (mode: PermissionMode): SdkPermissionMode =>
  mode === "auto" ? "bypassPermissions" : mode === "accept-edits" ? "acceptEdits" : "default"

/**
 * The gate request for a tool the SDK asked about, or null for read-only tools
 * (Read/Grep/Glob/…) which are never gated.
 */
export const toPermissionRequest = (
  toolName: string,
  input: Record<string, unknown>
): PermissionRequest | null => {
  if (isEditTool(toolName)) {
    return {
      kind: "edit",
      tool: toolName,
      target: strOf(input.file_path) ?? strOf(input.path) ?? strOf(input.notebook_path),
      command: null
    }
  }
  if (toolName === "Bash") {
    return { kind: "command", tool: "Bash", target: strOf(input.command), command: strOf(input.command) }
  }
  return null
}

const toolTarget = (name: string, input: Record<string, unknown>): string | null => {
  if (name === "Bash") return strOf(input.command)
  if (name === "Grep" || name === "Glob") return strOf(input.pattern)
  return strOf(input.file_path) ?? strOf(input.path) ?? strOf(input.notebook_path) ?? strOf(input.url)
}

const lineCount = (s: string): number => (s.length === 0 ? 0 : s.split("\n").length)

const firstLine = (s: string, sign: "+" | "-"): string | null => {
  const line = s.split("\n").find((l) => l.trim().length > 0)
  return line ? `${sign} ${line.trim()}` : null
}

/** Derive a `DiffStat` + one-line preview from an edit tool's input. */
export const editStats = (
  name: string,
  input: Record<string, unknown>
): { diff: DiffStat | null; preview: string | null } => {
  if (name === "Write") {
    const content = strOf(input.content) ?? ""
    return { diff: { added: lineCount(content), removed: 0 }, preview: firstLine(content, "+") }
  }
  if (name === "Edit" || name === "Update" || name === "NotebookEdit") {
    const oldS = strOf(input.old_string) ?? ""
    const newS = strOf(input.new_string) ?? ""
    return {
      diff: { added: lineCount(newS), removed: lineCount(oldS) },
      preview: firstLine(newS, "+") ?? firstLine(oldS, "-")
    }
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []
    let added = 0
    let removed = 0
    for (const e of edits) {
      added += lineCount(strOf(e.new_string) ?? "")
      removed += lineCount(strOf(e.old_string) ?? "")
    }
    return { diff: { added, removed }, preview: null }
  }
  return { diff: null, preview: null }
}

const contentBlocks = (message: unknown): ReadonlyArray<Record<string, unknown>> => {
  const content = (message as { content?: unknown } | null)?.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}

const toolResultMeta = (name: string | undefined, content: unknown): string | null => {
  if (name !== "Read") return null
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? strOf((content.find((b) => (b as { type?: unknown }).type === "text") as { text?: unknown } | undefined)?.text)
        : null
  return text ? `${lineCount(text)} lines` : null
}

const totalTokens = (usage: unknown): number => {
  const u = (usage ?? {}) as Record<string, unknown>
  return numOf(u.input_tokens) + numOf(u.output_tokens)
}

/** Remembers a tool call's name/input between its `tool_use` and `tool_result`. */
export interface ToolMemo {
  readonly name: string
  readonly input: Record<string, unknown>
}

/**
 * Fold one SDK message into normalized `StreamEvent`s. `tools` correlates a
 * `tool_use` with its later `tool_result` so an edit's diff/preview can be
 * attached at completion. Deterministic given (msg, tools) — unit tested.
 */
export const streamEventsFor = (
  msg: SDKMessage,
  tools: Map<string, ToolMemo>
): ReadonlyArray<StreamEvent> => {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" ? [{ _tag: "Started", sessionId: msg.session_id }] : []

    // Token-level streaming: assistant text arrives as content_block deltas.
    case "stream_event": {
      const event = (msg as { event?: { type?: string; delta?: Record<string, unknown> } }).event
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = strOf(event.delta.text)
        return text ? [{ _tag: "Assistant", text }] : []
      }
      return []
    }

    // The completed assistant message carries thinking (as a finished block) and
    // tool_use calls. Text is skipped here — it already streamed via deltas.
    case "assistant": {
      const out: StreamEvent[] = []
      for (const block of contentBlocks(msg.message)) {
        const type = block.type
        if (type === "thinking") {
          const text = strOf(block.thinking)
          if (text) out.push({ _tag: "Thinking", text, seconds: null, done: true })
        } else if (type === "tool_use") {
          const id = String(block.id)
          const name = String(block.name)
          const input = (block.input ?? {}) as Record<string, unknown>
          tools.set(id, { name, input })
          out.push({ _tag: "ToolStart", id, name, target: toolTarget(name, input) })
        }
      }
      return out
    }

    case "user": {
      const out: StreamEvent[] = []
      for (const block of contentBlocks(msg.message)) {
        if (block.type !== "tool_result") continue
        const id = String(block.tool_use_id)
        const memo = tools.get(id)
        const stats = memo && isEditTool(memo.name) ? editStats(memo.name, memo.input) : { diff: null, preview: null }
        out.push({
          _tag: "ToolEnd",
          id,
          status: block.is_error === true ? "error" : "success",
          meta: toolResultMeta(memo?.name, block.content),
          diff: stats.diff,
          preview: stats.preview
        })
      }
      return out
    }

    case "result":
      return [
        {
          _tag: "Done",
          costUsd: numOf((msg as { total_cost_usd?: unknown }).total_cost_usd),
          tokens: totalTokens((msg as { usage?: unknown }).usage)
        }
      ]

    default:
      return []
  }
}

// ── The live adapter ─────────────────────────────────────────────────────────

/**
 * Run one Claude turn in the session's worktree. Streams normalized events via
 * `ctx.emit`, bridges the SDK's `canUseTool` onto `ctx.canUseTool`, and stores
 * the SDK session id in `resume` so the next prompt continues the conversation.
 * Interrupting the Effect aborts the underlying run.
 */
export const runClaude = (
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
        const { query } = await import("@anthropic-ai/claude-agent-sdk")
        const tools = new Map<string, ToolMemo>()

        const canUseTool = async (
          toolName: string,
          input: Record<string, unknown>
        ): Promise<PermissionResult> => {
          const req = toPermissionRequest(toolName, input)
          if (req === null) return { behavior: "allow", updatedInput: input }
          const decision = await runP(ctx.canUseTool(req))
          return decision === "allow"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Denied by the operator." }
        }

        const iterator = query({
          prompt: spec.prompt,
          options: {
            cwd: spec.cwd || undefined,
            pathToClaudeCodeExecutable: spec.binPath ?? undefined,
            permissionMode: mapPermissionMode(spec.mode),
            ...(spec.mode === "auto" ? { allowDangerouslySkipPermissions: true } : {}),
            includePartialMessages: true,
            canUseTool,
            abortController: abort,
            resume: resume.get(sessionId)
          }
        })

        for await (const msg of iterator) {
          const sid = (msg as { session_id?: unknown }).session_id
          if (typeof sid === "string" && sid.length > 0) resume.set(sessionId, sid)
          for (const event of streamEventsFor(msg, tools)) {
            await runP(ctx.emit(event))
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
