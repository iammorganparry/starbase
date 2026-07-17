import type { DiffStat, PermissionMode, Question, QuestionAnswer, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { PermissionMode as SdkPermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Runtime } from "effect"
import type { AgentContext, PermissionRequest, SessionSpec } from "./adapter.js"
import { startTeeStream, type TeeStream } from "./bash-tee.js"
import { capOutput } from "./output-cap.js"
import { hasPlanBlock, parsePlan, planModeInstructions } from "./plan-parse.js"

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
 * How often a running Bash command's tee file is polled for new output. Fast
 * enough to feel live, slow enough that a chatty command doesn't flood the RPC —
 * each poll re-reads the whole file and re-sends only if it grew.
 */
const TEE_POLL_MS = 150

/**
 * How `spec.readOnly` is enforced on this harness: the SDK refuses these outright.
 *
 * Belt to `canUseTool`'s braces — that callback only fires for tool names
 * `toPermissionRequest` maps, so anything unrecognised is allowed ungated. `Task`
 * is included because a subagent is a second lever on the same worktree.
 * Read/Grep/Glob are deliberately absent: a read-only run still needs to read.
 */
const READ_ONLY_DISALLOWED: ReadonlyArray<string> = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Update",
  "Task",
  "Agent"
]

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
 * Handed back when a plan arrives without its ` ```plan ` fence. Starbase renders
 * plans from that block, so a fence-less plan has no steps to review — we ask for
 * one reformat before falling back to showing the raw markdown.
 */
export const PLAN_REFORMAT = [
  "Your plan is missing the required ```plan block, so Starbase cannot render it as a reviewable plan.",
  "Re-call ExitPlanMode with the SAME plan, but put a fenced ```plan block at the top of it:",
  "a `summary:` line, then each step as `01 Step title` with two-space-indented",
  "`intent:` / `approach:` / `files:` / `guards:` fields. Keep your human-readable markdown below the block.",
  "Do not change the substance of the plan — only its format.",
  // Without this the model can "comply" by printing the reformatted plan as prose
  // and ending the turn, which leaves no plan artifact at all. Calling the tool is
  // the only thing that produces one.
  "You MUST call the ExitPlanMode tool again — printing the plan as a message does not submit it."
].join(" ")

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
  // Invoking a skill: WHICH skill is the entire content of the card. Without
  // this the input's `skill`/`args` match nothing below, the target comes out
  // null, and the transcript shows a bare "Skill" — the one thing it needed to
  // say, missing.
  if (name === "Skill") {
    const skill = strOf(input.skill)
    if (skill === null) return null
    const args = strOf(input.args)
    return args ? `${skill} ${args}` : skill
  }
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

/** The text a `tool_result` carries, whether it arrived bare or in a block list. */
const toolResultText = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  return strOf(
    (content.find((b) => (b as { type?: unknown }).type === "text") as { text?: unknown } | undefined)?.text
  )
}

const toolResultMeta = (name: string | undefined, content: unknown): string | null => {
  if (name !== "Read") return null
  const text = toolResultText(content)
  return text ? `${lineCount(text)} lines` : null
}

/**
 * Tools whose `tool_result` is an acknowledgement rather than output.
 *
 * A backgrounded Task's result lands ~150ms after the spawn saying only "Async
 * agent launched successfully", while the agent itself runs on for minutes and
 * reports into its own tab. Showing that ACK as the call's "output" would state
 * the opposite of what's happening. (Same reason its tool_result doesn't settle
 * the tab — see the `SUPPRESSED_TOOLS` note and the bookend below.)
 */
const ACK_ONLY_TOOLS = new Set(["Task"])

/**
 * What a tool printed, for the card's expanded body.
 *
 * Edit tools are excluded: their result is a bare confirmation, and the card
 * already shows the real change as a diff peek built from the tool's INPUT — so
 * storing "ok" would cost transcript size on every edit and add nothing.
 */
const toolResultOutput = (name: string | undefined, content: unknown): string | undefined => {
  if (name !== undefined && (isEditTool(name) || ACK_ONLY_TOOLS.has(name))) return undefined
  const text = toolResultText(content)?.trim()
  return text ? capOutput(text) : undefined
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
      // A task's terminal bookend, and the AUTHORITATIVE completion for a
      // sub-agent. It is the only correct signal for a BACKGROUNDED Task, whose
      // `tool_result` arrives ~150ms after the spawn carrying just an "Async
      // agent launched successfully" ACK while the agent runs on for minutes.
      // It fires for SYNCHRONOUS Tasks too (just before their tool_result), so
      // settling here — rather than on the tool_result — is right either way.
      if (msg.subtype === "task_notification") {
        // Ambient/workflow tasks carry no tool_use_id: no tab to settle.
        const id = strOf(msg.tool_use_id)
        if (!id) return []
        return [{ _tag: "SubagentEnded", id, status: msg.status === "completed" ? "done" : "error" }]
      }
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
          // A `Task` opens a live, watch-only sub-agent tab keyed by this tool_use
          // id (its children arrive stamped with it). This holds at ANY depth: a
          // Task spawned BY a sub-agent (so `agentId` is set) opens a nested tab
          // parented to it, since the SDK stamps the immediate parent.
          if (SUBAGENT_TOOLS.has(name)) {
            out.push({
              _tag: "SubagentStarted",
              id,
              name: strOf(input.subagent_type) ?? "agent",
              description: strOf(input.description) ?? "",
              parentId: agentId ?? null
            })
          }
          if (SUPPRESSED_TOOLS.has(name)) continue
          // The Task's own ToolStart carries its SPAWNER's agentId (undefined for
          // the main agent), so the summary card anchors in the transcript that
          // made the call — the main turn, or the parent sub-agent's tab — while
          // the tab opened above holds the spawned agent's own output.
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
        // NOTE: a Task's tool_result deliberately does NOT settle its tab — for a
        // backgrounded Task it's only a launch ACK, so settling here flipped the
        // tab to "done" ~150ms in while the agent ran on for minutes. The tab is
        // settled by the `task_notification` bookend (see the "system" case).
        if (memo && SUPPRESSED_TOOLS.has(memo.name)) continue
        const stats = memo && isEditTool(memo.name) ? editStats(memo.name, memo.input) : { diff: null, preview: null }
        const output = toolResultOutput(memo?.name, block.content)
        out.push({
          _tag: "ToolEnd",
          id,
          status: block.is_error === true ? "error" : "success",
          meta: toolResultMeta(memo?.name, block.content),
          diff: stats.diff,
          preview: stats.preview,
          // Omit the key entirely when there's nothing to show, so a tool with no
          // output doesn't persist an empty field into every transcript.
          ...(output !== undefined ? { output } : {}),
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

        // ── Live bash output via tee (see bash-tee.ts) ──────────────────────
        // claude has no partial-output event, so an allowed Bash command is
        // rewritten to tee its output to a temp file we poll; each growth is a
        // ToolDelta on the SAME id as its ToolStart, so the card fills live.
        // toolUseId → its running stream; cleaned up when the command's ToolEnd
        // lands or the run ends.
        const teeStreams = new Map<string, TeeStream>()
        const stopTee = (toolUseId: string): void => {
          teeStreams.get(toolUseId)?.stop()
          teeStreams.delete(toolUseId)
        }
        /** Tee an allowed Bash command to a temp file, tail it as ToolDelta, and return the rewritten command. */
        const startTee = (toolUseId: string, command: string): string => {
          const stream = startTeeStream(
            toolUseId,
            command,
            (snapshot) => void runP(ctx.emit({ _tag: "ToolDelta", id: toolUseId, output: snapshot })),
            { pollMs: TEE_POLL_MS }
          )
          teeStreams.set(toolUseId, stream)
          return stream.command
        }

        // Set once `query()` returns, so `canUseTool` can flip the run out of plan
        // mode when the operator approves the plan.
        let planQuery: Query | null = null
        let planCount = 0
        let qn = 0
        // Whether we've already bounced a fence-less plan back for a reformat on
        // this run. Exactly one retry: a model that still won't comply degrades to
        // the raw fallback instead of ping-ponging forever.
        let planReformatAsked = false

        const canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
          options: { toolUseID: string }
        ): Promise<PermissionResult> => {
          // Plan mode: the SDK routes ExitPlanMode approval here. Turn the plan
          // into a structured, reviewable Plan and honour the operator's verdict.
          if (toolName === "ExitPlanMode") {
            const raw = strOf(input.plan) ?? ""
            // `planModeInstructions` documents the ` ```plan ` fence, but a model
            // can still skip it — and then the operator gets a plan with no
            // reviewable steps. Bounce the FIRST offender back through the same
            // deny.message channel a revision uses; it re-calls ExitPlanMode with
            // the fence and nobody sees the broken version.
            if (!hasPlanBlock(raw) && !planReformatAsked) {
              planReformatAsked = true
              return { behavior: "deny", message: PLAN_REFORMAT }
            }
            planCount += 1
            const plan = parsePlan(raw, `plan_${sessionId}_${planCount}`)
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
          if (decision !== "allow") return { behavior: "deny", message: "Denied by the operator." }
          // Allowed. For a Bash command, tee its output to a temp file we tail so
          // the card fills as it runs. Permission was decided on the ORIGINAL
          // command just above, so the rewrite can NEVER introduce a prompt; and
          // if the SDK declined to honour the changed command, streaming simply
          // no-ops — the original runs and ToolEnd still carries the full output.
          const teeId = options.toolUseID
          if (toolName === "Bash" && typeof input.command === "string" && input.command.length > 0 && teeId) {
            return { behavior: "allow", updatedInput: { ...input, command: startTee(teeId, input.command) } }
          }
          return { behavior: "allow", updatedInput: input }
        }

        // Resume id: prefer the live in-memory id (this launch), else the id
        // persisted on the session (survives an app restart), so "continue" always
        // reloads the full conversation instead of starting the harness fresh.
        // `fresh` bypasses the map entirely — the map otherwise WINS over
        // spec.resumeId, so a repeated run under the same key resumes the prior
        // conversation even when the caller explicitly asked for a new one.
        const resumeId = spec.fresh
          ? undefined
          : (resume.get(sessionId) ?? spec.resumeId ?? undefined)

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
            ...(spec.readOnly ? { disallowedTools: [...READ_ONLY_DISALLOWED] } : {}),
            includePartialMessages: true,
            canUseTool,
            abortController: abort,
            resume: resumeId
          }
        })
        planQuery = iterator

        try {
          for await (const msg of iterator) {
            const sid = (msg as { session_id?: unknown }).session_id
            // A `fresh` run must leave no trace in the map, or the NEXT run under
            // this key would resume it.
            if (!spec.fresh && typeof sid === "string" && sid.length > 0) {
              resume.set(sessionId, sid)
            }
            for (const event of streamEventsFor(msg, tools)) {
              // A command has finished: its ToolEnd carries the authoritative
              // output, so stop tailing and drop the temp file BEFORE emitting —
              // otherwise a late poll could re-open the settled card. A no-op for
              // any tool that wasn't teed.
              if (event._tag === "ToolEnd") stopTee(event.id)
              await runP(ctx.emit(event))
            }
          }
        } finally {
          // End of run (or a throw / interrupt-driven iterator close): tear down
          // any watcher still open — a command whose ToolEnd never arrived, or the
          // operator stopping mid-command — so no timer or temp file outlives it.
          for (const id of [...teeStreams.keys()]) stopTee(id)
        }
      },
      catch: (cause) =>
        new CliExecError({
          kind: spec.cli,
          message: cause instanceof Error ? cause.message : String(cause)
        })
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => abort.abort())))
  })
