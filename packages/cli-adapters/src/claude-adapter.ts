import type { DiffStat, PermissionMode, Question, QuestionAnswer, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { PermissionMode as SdkPermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Runtime } from "effect"
import type { AgentContext, PermissionRequest, SessionSpec } from "./adapter.js"
import { parsePlan, planModeInstructions } from "./plan-parse.js"

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

/**
 * Interactive tools surfaced via dedicated UI (the plan card / question card),
 * so their raw tool cards are suppressed from the transcript to avoid a redundant
 * (and confusingly "pending") duplicate.
 */
const SUPPRESSED_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"])

/**
 * Map our HITL mode onto the SDK's permission mode.
 *
 * "auto" maps to "default", NOT "bypassPermissions" — deliberately. The SDK
 * skips `canUseTool` entirely under "bypassPermissions" (it warns as much:
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and that callback is not just a permission
 * gate: it's where `ExitPlanMode` and `AskUserQuestion` are intercepted and
 * turned into the plan / question cards. Shadowed, `AskUserQuestion` is
 * auto-approved, runs headlessly and silently skips — the agent's question
 * never reaches the operator.
 *
 * Nothing is lost by dropping it: `verdict()` in `agent-runner.ts` already
 * returns "allow" for every request in "auto", so our own gate keeps the mode
 * ungated. This is the same reasoning the plan-approval path uses when it
 * restores "default" mid-run (see `setPermissionMode` below).
 */
export const mapPermissionMode = (mode: PermissionMode): SdkPermissionMode =>
  mode === "accept-edits" ? "acceptEdits" : mode === "plan" ? "plan" : "default"

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

/**
 * Parse the SDK AskUserQuestion dialog payload (`{ questions: [...] }`) into our
 * `Question[]`. Defensive — the payload is transported opaquely, so every field
 * is treated as possibly-absent. Returns [] when there's nothing renderable.
 */
export const parseSdkQuestions = (payload: Record<string, unknown>): ReadonlyArray<Question> => {
  const raw = Array.isArray(payload.questions) ? (payload.questions as Array<Record<string, unknown>>) : []
  return raw
    .map((q): Question => {
      const opts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []
      return {
        question: strOf(q.question) ?? "",
        header: strOf(q.header) ?? "",
        multiSelect: q.multiSelect === true,
        options: opts.map((o) => {
          const preview = strOf(o.preview)
          return {
            label: strOf(o.label) ?? "",
            description: strOf(o.description) ?? "",
            ...(preview ? { preview } : {})
          }
        })
      }
    })
    .filter((q) => q.question.length > 0 && q.options.length > 0)
}

/**
 * Format the operator's answers as the reply the model reads. AskUserQuestion is
 * a permission-gated tool in this SDK (not a dialog), and `canUseTool` can only
 * allow/deny — so the deny `message` is the only channel that carries content
 * back. We phrase the picks as the answer so the model continues with them.
 * Pure + exported for regression coverage of the exact wording.
 */
export const formatQuestionAnswer = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>
): string => {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    const picks = a ? [...a.selected, ...(a.other ? [a.other] : [])] : []
    return `• ${q.header || q.question}: ${picks.join(", ") || "(no selection)"}`
  })
  return `The user answered your question(s):\n${lines.join("\n")}\n\nUse these answers and continue — do not ask again.`
}

/**
 * Tools that spawn a watch-only sub-agent. Claude Code has surfaced this as
 * `Task` and (in newer builds) `Agent`; treat both as a sub-agent spawn so each
 * gets its own readable tab.
 */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"])

const toolTarget = (name: string, input: Record<string, unknown>): string | null => {
  if (name === "Bash") return strOf(input.command)
  if (name === "Grep" || name === "Glob") return strOf(input.pattern)
  // A sub-agent spawn's target is its one-line task description.
  if (SUBAGENT_TOOLS.has(name)) return strOf(input.description)
  return strOf(input.file_path) ?? strOf(input.path) ?? strOf(input.notebook_path) ?? strOf(input.url)
}

const lineCount = (s: string): number => (s.length === 0 ? 0 : s.split("\n").length)

// ── Diff-hunk preview ────────────────────────────────────────────────────────
// The preview is a unified-diff hunk: each line's FIRST character is the marker
// ("+" added, "-" removed, " " context, "…" a truncation gutter), the rest is the
// code verbatim. Content-independent so a context line that happens to start with
// "+"/"-" is never mis-tinted. `DiffPeek` renders it.

/** Context lines kept either side of a change, so the edit reads in situ. */
const HUNK_CONTEXT = 3
/** Cap the changed region so a huge replace doesn't produce a wall of lines. */
const HUNK_MAX_CHANGED = 40

const mark = (sign: "+" | "-" | " ", line: string): string => `${sign}${line}`

/** Truncate a run of changed lines, appending a "… N more" gutter when clipped. */
const clip = (lines: ReadonlyArray<string>, sign: "+" | "-"): ReadonlyArray<string> => {
  if (lines.length <= HUNK_MAX_CHANGED) return lines.map((l) => mark(sign, l))
  const shown = lines.slice(0, HUNK_MAX_CHANGED).map((l) => mark(sign, l))
  return [...shown, `…${lines.length - HUNK_MAX_CHANGED} more ${sign === "+" ? "added" : "removed"} line(s)`]
}

/**
 * Build a unified-diff hunk from an edit's `old_string`/`new_string` by trimming
 * the common prefix/suffix (the surrounding lines Claude includes to disambiguate
 * the edit) down to `HUNK_CONTEXT` lines of context around the actual change.
 * Returns null when there is no line-level change to show.
 */
const unifiedHunk = (oldS: string, newS: string): string | null => {
  const o = oldS.length === 0 ? [] : oldS.split("\n")
  const n = newS.length === 0 ? [] : newS.split("\n")
  let p = 0
  while (p < o.length && p < n.length && o[p] === n[p]) p++
  let s = 0
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++
  const removed = o.slice(p, o.length - s)
  const added = n.slice(p, n.length - s)
  if (removed.length === 0 && added.length === 0) return null

  const preFrom = Math.max(0, p - HUNK_CONTEXT)
  const postTo = Math.min(o.length, o.length - s + HUNK_CONTEXT)
  const out: Array<string> = []
  if (preFrom > 0) out.push("…")
  for (const c of o.slice(preFrom, p)) out.push(mark(" ", c))
  out.push(...clip(removed, "-"))
  out.push(...clip(added, "+"))
  for (const c of o.slice(o.length - s, postTo)) out.push(mark(" ", c))
  if (postTo < o.length) out.push("…")
  return out.join("\n")
}

/** First N lines of new file content as an added-only hunk (for Write). */
const addedHunk = (content: string): string | null => {
  if (content.length === 0) return null
  const lines = content.split("\n")
  const shown = lines.slice(0, HUNK_MAX_CHANGED).map((l) => mark("+", l))
  if (lines.length > HUNK_MAX_CHANGED) shown.push(`…${lines.length - HUNK_MAX_CHANGED} more line(s)`)
  return shown.join("\n")
}

/** Derive a `DiffStat` + a multi-line diff-hunk preview from an edit tool's input. */
export const editStats = (
  name: string,
  input: Record<string, unknown>
): { diff: DiffStat | null; preview: string | null } => {
  if (name === "Write") {
    const content = strOf(input.content) ?? ""
    return { diff: { added: lineCount(content), removed: 0 }, preview: addedHunk(content) }
  }
  if (name === "Edit" || name === "Update" || name === "NotebookEdit") {
    const oldS = strOf(input.old_string) ?? ""
    const newS = strOf(input.new_string) ?? ""
    return {
      diff: { added: lineCount(newS), removed: lineCount(oldS) },
      preview: unifiedHunk(oldS, newS)
    }
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []
    let added = 0
    let removed = 0
    const hunks: Array<string> = []
    for (const e of edits) {
      const oldS = strOf(e.old_string) ?? ""
      const newS = strOf(e.new_string) ?? ""
      added += lineCount(newS)
      removed += lineCount(oldS)
      const h = unifiedHunk(oldS, newS)
      if (h !== null) hunks.push(h)
    }
    // Separate each edit's hunk with a blank context line so they read as distinct.
    return { diff: { added, removed }, preview: hunks.length > 0 ? hunks.join("\n \n") : null }
  }
  return { diff: null, preview: null }
}

/**
 * Build the SDK `query` prompt for a turn. With no attachments it's the plain
 * text string (unchanged behaviour). With images it becomes the SDK's
 * streaming-input form: a single user message whose content interleaves the text
 * with base64 image blocks — the shape the harness reads images from. Pure +
 * exported so the interleaving is unit-tested without the live SDK.
 */
export const buildPromptInput = (
  spec: SessionSpec,
  resumeId: string | undefined
): string | AsyncIterable<SDKUserMessage> => {
  if (spec.images.length === 0) return spec.prompt
  const content = [
    ...(spec.prompt.length > 0 ? [{ type: "text", text: spec.prompt }] : []),
    ...spec.images.map((img) => ({
      type: "image",
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data }
    }))
  ]
  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: resumeId ?? ""
    } as SDKUserMessage
  })()
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
  // The SDK stamps a sub-agent's own messages with the spawning `Task` tool_use
  // id. When set, this message's content belongs to that sub-agent's live tab,
  // not the main turn — so we tag each emitted content event with it.
  const agentId = strOf((msg as { parent_tool_use_id?: unknown }).parent_tool_use_id) || undefined
  const forAgent = agentId ? { agentId } : {}

  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return []
      const model = strOf(msg.model)
      return [
        model
          ? { _tag: "Started", sessionId: msg.session_id, model }
          : { _tag: "Started", sessionId: msg.session_id }
      ]
    }

    // Token-level streaming: assistant text arrives as content_block deltas.
    case "stream_event": {
      const event = (msg as { event?: { type?: string; delta?: Record<string, unknown> } }).event
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = strOf(event.delta.text)
        return text ? [{ _tag: "Assistant", text, ...forAgent }] : []
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
          if (text) out.push({ _tag: "Thinking", text, seconds: null, done: true, ...forAgent })
        } else if (type === "tool_use") {
          const id = String(block.id)
          const name = String(block.name)
          const input = (block.input ?? {}) as Record<string, unknown>
          tools.set(id, { name, input })
          // A `Task` spawned by the MAIN agent opens a live, watch-only sub-agent
          // tab keyed by this tool_use id (its children arrive stamped with it).
          // Nested Tasks (spawned by a sub-agent, so `agentId` is set) stay as
          // ordinary tool cards — one level of nesting for MVP.
          if (SUBAGENT_TOOLS.has(name) && agentId === undefined) {
            out.push({
              _tag: "SubagentStarted",
              id,
              name: strOf(input.subagent_type) ?? "agent",
              description: strOf(input.description) ?? ""
            })
          }
          if (SUPPRESSED_TOOLS.has(name)) continue
          // The Task's own ToolStart is untagged (agentId undefined) so it anchors
          // a summary card in the MAIN transcript alongside opening the tab.
          out.push({ _tag: "ToolStart", id, name, target: toolTarget(name, input), ...forAgent })
        }
      }
      // Live token count: the SDK stamps cumulative turn usage on each assistant
      // message, so surface it as it grows (the final `Done` still carries the
      // authoritative total). Only the main agent's usage drives the readout.
      if (agentId === undefined) {
        const tokens = totalTokens((msg.message as { usage?: unknown }).usage)
        if (tokens > 0) out.push({ _tag: "Usage", tokens })
      }
      return out
    }

    case "user": {
      const out: StreamEvent[] = []
      for (const block of contentBlocks(msg.message)) {
        if (block.type !== "tool_result") continue
        const id = String(block.tool_use_id)
        const memo = tools.get(id)
        // A top-level `Task` completing closes its sub-agent tab (tabs are
        // live-only — the anchor card in the main turn keeps the summary).
        if (memo && SUBAGENT_TOOLS.has(memo.name) && agentId === undefined) {
          out.push({ _tag: "SubagentEnded", id, status: block.is_error === true ? "error" : "done" })
        }
        if (memo && SUPPRESSED_TOOLS.has(memo.name)) continue
        const stats = memo && isEditTool(memo.name) ? editStats(memo.name, memo.input) : { diff: null, preview: null }
        out.push({
          _tag: "ToolEnd",
          id,
          status: block.is_error === true ? "error" : "success",
          meta: toolResultMeta(memo?.name, block.content),
          diff: stats.diff,
          preview: stats.preview,
          ...forAgent
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

        // Set once `query()` returns, so `canUseTool` can flip the run out of plan
        // mode when the operator approves the plan.
        let planQuery: Query | null = null
        let planCount = 0
        let qn = 0

        const canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
          options: { toolUseID: string }
        ): Promise<PermissionResult> => {
          // Plan mode: the SDK routes ExitPlanMode approval here. Turn the plan
          // into a structured, reviewable Plan and honour the operator's verdict.
          if (toolName === "ExitPlanMode") {
            planCount += 1
            const plan = parsePlan(strOf(input.plan) ?? "", `plan_${sessionId}_${planCount}`)
            const decision = await runP(ctx.proposePlan(plan))
            if (decision._tag === "Approve") {
              // Exit plan mode via "default" — the same mode every non-plan run
              // uses (see `mapPermissionMode`), so canUseTool below keeps being
              // consulted and enforces the session's restored HITL mode; an
              // "auto" approval still runs ungated via `verdict()`. Best-effort:
              // never let a permission-mode hiccup block the approval.
              try {
                await planQuery?.setPermissionMode("default")
              } catch {
                /* ignore — the tool is still allowed and canUseTool governs gating */
              }
              return { behavior: "allow", updatedInput: input }
            }
            return {
              behavior: "deny",
              message: decision._tag === "Revise" ? decision.feedback : "Plan rejected by the operator."
            }
          }
          // AskUserQuestion arrives as a PERMISSION request (not a dialog) in this
          // SDK — running it headlessly just skips. So we intercept it: dock our
          // question card, collect the picks, and hand them back. `canUseTool` can
          // only allow/deny, and `deny.message` is the only channel that returns
          // content to the model — so we deny with the answers phrased as the reply.
          if (toolName === "AskUserQuestion") {
            const questions = parseSdkQuestions(input)
            if (questions.length === 0) return { behavior: "allow", updatedInput: input }
            qn += 1
            const answers = await runP(
              ctx.askQuestion({ id: options.toolUseID ?? `q_${sessionId}_${qn}`, questions })
            )
            return { behavior: "deny", message: formatQuestionAnswer(questions, answers) }
          }
          const req = toPermissionRequest(toolName, input)
          if (req === null) return { behavior: "allow", updatedInput: input }
          const decision = await runP(ctx.canUseTool(req))
          return decision === "allow"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Denied by the operator." }
        }

        // Resume id: prefer the live in-memory id (this launch), else the id
        // persisted on the session (survives an app restart), so "continue" always
        // reloads the full conversation instead of starting the harness fresh.
        const resumeId = resume.get(sessionId) ?? spec.resumeId ?? undefined

        // With attached images this switches to the SDK's streaming-input form
        // (text + base64 image blocks); without images it stays the string prompt.
        const iterator = query({
          prompt: buildPromptInput(spec, resumeId),
          options: {
            cwd: spec.cwd || undefined,
            pathToClaudeCodeExecutable: spec.binPath ?? undefined,
            model: spec.model ?? undefined,
            permissionMode: mapPermissionMode(spec.mode),
            ...(spec.mode === "plan" ? { planModeInstructions } : {}),
            includePartialMessages: true,
            canUseTool,
            abortController: abort,
            resume: resumeId
          }
        })
        planQuery = iterator

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
