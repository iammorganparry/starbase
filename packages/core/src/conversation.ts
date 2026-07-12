import { Match, Schema } from "effect"
import { DiffStat } from "./domain.js"

/**
 * Conversation domain — the transcript model plus the normalized `StreamEvent`
 * seam every harness (claude / codex / cursor) parses its output into. Because
 * the UI only ever sees these shapes, the chat experience is identical
 * regardless of which model or harness drives it.
 *
 * `applyStreamEvent` (bottom of file) folds a `StreamEvent` into a `Message` and
 * is the single source of truth for that fold — reused by the main-process
 * `AgentRunner` (to persist the transcript) and the renderer hook (to render it
 * live), so persisted history and the live view can never drift.
 */

// ── Roles & tool calls ───────────────────────────────────────────────────────

export const MessageRole = Schema.Literal("user", "assistant")
export type MessageRole = Schema.Schema.Type<typeof MessageRole>

/** Lifecycle of a single tool invocation, mirrored by the tool card's styling. */
export const ToolStatus = Schema.Literal("running", "success", "error")
export type ToolStatus = Schema.Schema.Type<typeof ToolStatus>

/** A tool invocation rendered as a card (with optional inline diff peek). */
export const ToolCall = Schema.Struct({
  id: Schema.String,
  /** e.g. "Read", "Edit", "Bash", "Grep". */
  name: Schema.String,
  /** Primary target — file path or query, or null. */
  target: Schema.NullOr(Schema.String),
  status: ToolStatus,
  /** Trailing meta, e.g. "142 lines" / "0 hits" / "6 commits". */
  meta: Schema.NullOr(Schema.String),
  /** Added/removed line counts, for edit-style tools. */
  diff: Schema.NullOr(DiffStat),
  /** A compact unified-diff snippet shown inline under the card (Edit). */
  preview: Schema.NullOr(Schema.String)
})
export type ToolCall = Schema.Schema.Type<typeof ToolCall>

// ── HITL approval gate ───────────────────────────────────────────────────────

/** What the agent is asking permission to do. */
export const GateKind = Schema.Literal("command", "edit")
export type GateKind = Schema.Schema.Type<typeof GateKind>

export const GateStatus = Schema.Literal("pending", "approved", "rejected", "always")
export type GateStatus = Schema.Schema.Type<typeof GateStatus>

/** The operator's decision on a pending gate. */
export const GateDecision = Schema.Literal("allow", "deny", "always")
export type GateDecision = Schema.Schema.Type<typeof GateDecision>

/** An approval gate that pauses the agent for a human decision (HITL). */
export const ApprovalGate = Schema.Struct({
  id: Schema.String,
  kind: GateKind,
  title: Schema.String,
  detail: Schema.String,
  /** The shell command awaiting approval, when `kind === "command"`. */
  command: Schema.NullOr(Schema.String),
  /** Label for the "Always allow …" button, e.g. "npm test". */
  allowLabel: Schema.NullOr(Schema.String),
  status: GateStatus
})
export type ApprovalGate = Schema.Schema.Type<typeof ApprovalGate>

// ── Ask-user-question (structured multiple-choice, like the SDK tool) ─────────

/** One choice in a question. `preview` is optional rich content for comparison. */
export const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.String,
  preview: Schema.optional(Schema.String)
})
export type QuestionOption = Schema.Schema.Type<typeof QuestionOption>

/** A single question with 2–4 options; `multiSelect` allows picking several. */
export const Question = Schema.Struct({
  /** The full question text (ends with "?"). */
  question: Schema.String,
  /** A short chip label (≤12 chars), e.g. "Auth method". */
  header: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean
})
export type Question = Schema.Schema.Type<typeof Question>

/** The agent's answer to one question: selected option labels + optional "Other". */
export const QuestionAnswer = Schema.Struct({
  selected: Schema.Array(Schema.String),
  /** Free-text "Other" answer, or null. */
  other: Schema.NullOr(Schema.String)
})
export type QuestionAnswer = Schema.Schema.Type<typeof QuestionAnswer>

/** A group of 1–4 questions the agent asked (one AskUserQuestion invocation). */
export const QuestionRequest = Schema.Struct({
  id: Schema.String,
  questions: Schema.Array(Question)
})
export type QuestionRequest = Schema.Schema.Type<typeof QuestionRequest>

// ── Content parts (ordered, interleaved) ─────────────────────────────────────

export const TextPart = Schema.TaggedStruct("Text", { text: Schema.String })
export type TextPart = Schema.Schema.Type<typeof TextPart>

export const ThinkingPart = Schema.TaggedStruct("Thinking", {
  text: Schema.String,
  /** Reasoning duration once finished, or null while streaming. */
  seconds: Schema.NullOr(Schema.Number),
  streaming: Schema.Boolean
})
export type ThinkingPart = Schema.Schema.Type<typeof ThinkingPart>

export const ToolPart = Schema.TaggedStruct("Tool", { tool: ToolCall })
export type ToolPart = Schema.Schema.Type<typeof ToolPart>

export const GatePart = Schema.TaggedStruct("Gate", { gate: ApprovalGate })
export type GatePart = Schema.Schema.Type<typeof GatePart>

/**
 * A pending (or answered) AskUserQuestion. `answers` is null while awaiting the
 * user, then one `QuestionAnswer` per question once submitted.
 */
export const QuestionPart = Schema.TaggedStruct("Question", {
  request: QuestionRequest,
  answers: Schema.NullOr(Schema.Array(QuestionAnswer))
})
export type QuestionPart = Schema.Schema.Type<typeof QuestionPart>

/** One ordered piece of a turn — text, thinking, a tool card, a gate, or a question. */
export const ContentPart = Schema.Union(TextPart, ThinkingPart, ToolPart, GatePart, QuestionPart)
export type ContentPart = Schema.Schema.Type<typeof ContentPart>

/** One turn in the transcript: an ordered list of content parts. */
export const Message = Schema.Struct({
  id: Schema.String,
  role: MessageRole,
  parts: Schema.Array(ContentPart),
  /** True while the agent is still producing this turn. */
  streaming: Schema.Boolean,
  createdAt: Schema.String
})
export type Message = Schema.Schema.Type<typeof Message>

// ── Skills (harness-reported, for the `/` menu) ──────────────────────────────

/** A skill or slash-command the selected harness exposes in the `/` menu. */
export const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  source: Schema.Literal("skill", "command")
})
export type Skill = Schema.Schema.Type<typeof Skill>

// ── Normalized stream events (the harness-agnostic seam) ──────────────────────

export const StreamEvent = Schema.Union(
  Schema.TaggedStruct("Started", {
    sessionId: Schema.String,
    /** The actual model the harness is running, when known (from init). */
    model: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("Thinking", {
    text: Schema.String,
    seconds: Schema.NullOr(Schema.Number),
    done: Schema.Boolean
  }),
  Schema.TaggedStruct("Assistant", { text: Schema.String }),
  Schema.TaggedStruct("ToolStart", {
    id: Schema.String,
    name: Schema.String,
    target: Schema.NullOr(Schema.String)
  }),
  Schema.TaggedStruct("ToolEnd", {
    id: Schema.String,
    status: ToolStatus,
    meta: Schema.NullOr(Schema.String),
    diff: Schema.NullOr(DiffStat),
    preview: Schema.NullOr(Schema.String)
  }),
  Schema.TaggedStruct("GateRequested", { gate: ApprovalGate }),
  Schema.TaggedStruct("QuestionRequested", { request: QuestionRequest }),
  Schema.TaggedStruct("Done", { costUsd: Schema.Number, tokens: Schema.Number }),
  Schema.TaggedStruct("Failed", { message: Schema.String })
)
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>

// ── Constructors & fold ──────────────────────────────────────────────────────

/** A fresh user turn (already complete). */
export const userMessage = (id: string, text: string, createdAt: string): Message => ({
  id,
  role: "user",
  parts: [{ _tag: "Text", text }],
  streaming: false,
  createdAt
})

/** A fresh, empty assistant turn to be filled by streaming events. */
export const assistantMessage = (id: string, createdAt: string): Message => ({
  id,
  role: "assistant",
  parts: [],
  streaming: true,
  createdAt
})

/**
 * Clear any leftover `streaming` flags from a persisted message. A transcript
 * loaded from disk has no live run, so a turn still marked streaming (the app was
 * closed mid-response) would otherwise show the typing indicator forever. Also
 * settles a `Thinking` part left mid-stream. Returns the same object when nothing
 * is streaming, so a clean transcript isn't needlessly copied.
 */
export const settleStreaming = (msg: Message): Message => {
  const partStreaming = msg.parts.some((p) => p._tag === "Thinking" && p.streaming)
  if (!msg.streaming && !partStreaming) return msg
  return {
    ...msg,
    streaming: false,
    parts: msg.parts.map((p) => (p._tag === "Thinking" && p.streaming ? { ...p, streaming: false } : p))
  }
}

const replaceLast = (
  parts: ReadonlyArray<ContentPart>,
  next: ContentPart
): ReadonlyArray<ContentPart> => [...parts.slice(0, -1), next]

/**
 * Fold one normalized `StreamEvent` into an assistant `Message`, returning a new
 * message. Pure and total — the same fold persists the transcript in the runner
 * and drives the live view in the renderer. Deltas accumulate onto the trailing
 * part of the same kind; tool completions patch the matching running tool.
 */
export const applyStreamEvent = (msg: Message, event: StreamEvent): Message => {
  const parts = msg.parts
  const last = parts[parts.length - 1]

  return Match.value(event).pipe(
    Match.tag("Started", () => ({ ...msg, streaming: true })),

    Match.tag("Thinking", (e) => {
      const continues = last !== undefined && last._tag === "Thinking" && last.streaming
      const next: ThinkingPart = {
        _tag: "Thinking",
        text: continues ? last.text + e.text : e.text,
        seconds: e.seconds ?? (last !== undefined && last._tag === "Thinking" ? last.seconds : null),
        streaming: !e.done
      }
      return { ...msg, parts: continues ? replaceLast(parts, next) : [...parts, next] }
    }),

    Match.tag("Assistant", (e) => {
      const continues = last !== undefined && last._tag === "Text"
      const next: TextPart = { _tag: "Text", text: continues ? last.text + e.text : e.text }
      return { ...msg, parts: continues ? replaceLast(parts, next) : [...parts, next] }
    }),

    Match.tag("ToolStart", (e) => {
      const part: ToolPart = {
        _tag: "Tool",
        tool: {
          id: e.id,
          name: e.name,
          target: e.target,
          status: "running",
          meta: null,
          diff: null,
          preview: null
        }
      }
      return { ...msg, parts: [...parts, part] }
    }),

    Match.tag("ToolEnd", (e) => ({
      ...msg,
      parts: parts.map((p): ContentPart =>
        p._tag === "Tool" && p.tool.id === e.id
          ? { _tag: "Tool", tool: { ...p.tool, status: e.status, meta: e.meta, diff: e.diff, preview: e.preview } }
          : p
      )
    })),

    Match.tag("GateRequested", (e) => {
      const part: GatePart = { _tag: "Gate", gate: e.gate }
      return { ...msg, parts: [...parts, part] }
    }),

    Match.tag("QuestionRequested", (e) => {
      const part: QuestionPart = { _tag: "Question", request: e.request, answers: null }
      return { ...msg, parts: [...parts, part] }
    }),

    Match.tag("Done", () => ({ ...msg, streaming: false })),

    Match.tag("Failed", (e) => {
      const part: TextPart = { _tag: "Text", text: e.message }
      return { ...msg, streaming: false, parts: [...parts, part] }
    }),

    Match.exhaustive
  )
}

/** Update a gate part's status in place (after the operator decides). */
export const setGateStatus = (msg: Message, gateId: string, status: GateStatus): Message => ({
  ...msg,
  parts: msg.parts.map((p) =>
    p._tag === "Gate" && p.gate.id === gateId ? { _tag: "Gate", gate: { ...p.gate, status } } : p
  )
})

/** Record the answers on a pending question part (after the user submits them). */
export const setQuestionAnswers = (
  msg: Message,
  requestId: string,
  answers: ReadonlyArray<QuestionAnswer>
): Message => ({
  ...msg,
  parts: msg.parts.map((p) =>
    p._tag === "Question" && p.request.id === requestId ? { ...p, answers } : p
  )
})

/** The first unanswered question group across a transcript, or null. */
export const pendingQuestion = (
  messages: ReadonlyArray<Message>
): QuestionRequest | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]!.parts) {
      if (part._tag === "Question" && part.answers === null) return part.request
    }
  }
  return null
}
