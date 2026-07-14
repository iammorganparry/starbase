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

// ── Plan (interactive, structured — plan mode) ───────────────────────────────

/** A file the plan proposes to touch, with change kind + line delta. */
export const PlanFileChange = Schema.Struct({
  path: Schema.String,
  /** Added / Modified / Deleted. */
  change: Schema.Literal("A", "M", "D"),
  added: Schema.Number,
  removed: Schema.Number
})
export type PlanFileChange = Schema.Schema.Type<typeof PlanFileChange>

/** Review state of an acceptance criterion (drives the ✓/!/○ checklist). */
export const PlanGuardStatus = Schema.Literal("ok", "warn", "open", "under-review")
export type PlanGuardStatus = Schema.Schema.Type<typeof PlanGuardStatus>

/** An acceptance criterion / guard on a step. */
export const PlanGuard = Schema.Struct({
  text: Schema.String,
  status: PlanGuardStatus
})
export type PlanGuard = Schema.Schema.Type<typeof PlanGuard>

/** Who wrote a step comment — the human scrutinising, or the agent replying. */
export const PlanCommentAuthor = Schema.Literal("user", "agent")
export type PlanCommentAuthor = Schema.Schema.Type<typeof PlanCommentAuthor>

/** A comment threaded on a plan step. `routed` flips true once sent to the agent. */
export const PlanComment = Schema.Struct({
  id: Schema.String,
  stepId: Schema.String,
  body: Schema.String,
  author: PlanCommentAuthor,
  createdAt: Schema.String,
  routed: Schema.Boolean
})
export type PlanComment = Schema.Schema.Type<typeof PlanComment>

/** A branch parent fans out to arms; a plain step is `step`. */
export const PlanStepKind = Schema.Literal("step", "branch", "branch-arm")
export type PlanStepKind = Schema.Schema.Type<typeof PlanStepKind>

export const PlanStepStatus = Schema.Literal("proposed", "current", "revising", "done")
export type PlanStepStatus = Schema.Schema.Type<typeof PlanStepStatus>

/**
 * An illustrative code sample for a step — the proposed service method, test, or
 * type the agent intends to write, so the operator can scrutinise the *shape* of
 * the change before approving. `lang` is a highlight hint (e.g. "ts"); `body` is
 * the raw snippet.
 */
export const PlanStepCode = Schema.Struct({
  lang: Schema.NullOr(Schema.String),
  body: Schema.String
})
export type PlanStepCode = Schema.Schema.Type<typeof PlanStepCode>

// ── Decision graph (how a step's logic/decisions flow — rendered on a react-flow canvas) ──

/**
 * A node in a plan step's decision graph. `decision` nodes branch (their
 * out-edges carry the conditions); `action`/`io`/`terminal`/`start` are the flow
 * between. Defined above `PlanStep` because each step now carries its own graph.
 */
export const PlanNodeKind = Schema.Literal("start", "decision", "action", "io", "terminal", "note")
export type PlanNodeKind = Schema.Schema.Type<typeof PlanNodeKind>

export const PlanNode = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: PlanNodeKind,
  /** Secondary line (a file, a call, a note), or null. */
  detail: Schema.NullOr(Schema.String),
  /** Links this node to a plan step, so clicking it opens that step's spec. */
  stepId: Schema.NullOr(Schema.String)
})
export type PlanNode = Schema.Schema.Type<typeof PlanNode>

export const PlanEdge = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  /** The condition / choice this edge represents (e.g. "yes", "token expired"), or null. */
  label: Schema.NullOr(Schema.String)
})
export type PlanEdge = Schema.Schema.Type<typeof PlanEdge>

/** A map of how the decisions + logic flow through a single step's change. */
export const PlanGraph = Schema.Struct({
  nodes: Schema.Array(PlanNode),
  edges: Schema.Array(PlanEdge)
})
export type PlanGraph = Schema.Schema.Type<typeof PlanGraph>

/** One node of the plan — an ordered step or a branch/arm. */
export const PlanStep = Schema.Struct({
  id: Schema.String,
  /** Display ordinal, e.g. "01", "04", "4a". */
  number: Schema.String,
  title: Schema.String,
  intent: Schema.String,
  /** Numbered "how" — one entry per line in the step spec. */
  approach: Schema.Array(Schema.String),
  kind: PlanStepKind,
  /** The branch question when `kind === "branch"` (e.g. "token expired"), else null. */
  condition: Schema.NullOr(Schema.String),
  /** The branch step this arm hangs off, when `kind === "branch-arm"`, else null. */
  parentId: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  blocks: Schema.Array(Schema.String),
  files: Schema.Array(PlanFileChange),
  guards: Schema.Array(PlanGuard),
  /**
   * An illustrative code sample of the proposed change, or null. `optionalWith`
   * (default null) so transcripts persisted before this field decode cleanly
   * instead of blanking the whole conversation.
   */
  code: Schema.optionalWith(Schema.NullOr(PlanStepCode), { default: () => null }),
  /**
   * This step's own decision/logic flow (a state machine / user flow grounded in
   * the step's code), or absent/null when the step needs none. Optional so
   * transcripts persisted before per-step flows decode cleanly, and so the many
   * step literals in seeds/tests don't each need to spell it out.
   */
  graph: Schema.optional(Schema.NullOr(PlanGraph)),
  diff: Schema.NullOr(DiffStat),
  status: PlanStepStatus,
  flagged: Schema.Boolean
})
export type PlanStep = Schema.Schema.Type<typeof PlanStep>

export const PlanStatus = Schema.Literal("proposed", "revising", "approved", "rejected", "stale")
export type PlanStatus = Schema.Schema.Type<typeof PlanStatus>

/**
 * A structured plan the agent proposed (via ExitPlanMode) and the operator can
 * scrutinise, comment on, route back for revision, and finally approve to start
 * execution. `raw` preserves the original markdown for fallback rendering.
 */
export const Plan = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  /**
   * Legacy plan-level flow graph — flows now live per-step (`PlanStep.graph`).
   * Kept optional so a single untagged ` ```flow ` block from an older plan, and
   * transcripts persisted before per-step flows, still decode.
   */
  graph: Schema.optional(Schema.NullOr(PlanGraph)),
  steps: Schema.Array(PlanStep),
  comments: Schema.Array(PlanComment),
  status: PlanStatus,
  raw: Schema.String
})
export type Plan = Schema.Schema.Type<typeof Plan>

// ── Content parts (ordered, interleaved) ─────────────────────────────────────

export const TextPart = Schema.TaggedStruct("Text", { text: Schema.String })
export type TextPart = Schema.Schema.Type<typeof TextPart>

/**
 * An image the operator attached as context for a prompt. `data` is the raw
 * bytes base64-encoded (no `data:` prefix) so it round-trips through JSON/RPC and
 * can be handed straight to the harness; the UI renders it as a data URL.
 */
export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** MIME type, e.g. "image/png". */
  mediaType: Schema.String,
  data: Schema.String
})
export type Attachment = Schema.Schema.Type<typeof Attachment>

/** An attached image, carried on the user's turn and shown as a thumbnail. */
export const ImagePart = Schema.TaggedStruct("Image", { attachment: Attachment })
export type ImagePart = Schema.Schema.Type<typeof ImagePart>

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

/** A structured plan proposed by the agent, awaiting scrutiny / approval. */
export const PlanPart = Schema.TaggedStruct("Plan", { plan: Plan })
export type PlanPart = Schema.Schema.Type<typeof PlanPart>

/** One ordered piece of a turn — text, an image, thinking, a tool card, a gate, a question, or a plan. */
export const ContentPart = Schema.Union(
  TextPart,
  ImagePart,
  ThinkingPart,
  ToolPart,
  GatePart,
  QuestionPart,
  PlanPart
)
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

// ── Sub-agents (harness `Task` spawns, surfaced as live watch-only tabs) ──────

/** Lifecycle of a spawned sub-agent, mirrored by its tab's status dot. */
export const SubagentStatus = Schema.Literal("working", "done", "error")
export type SubagentStatus = Schema.Schema.Type<typeof SubagentStatus>

/**
 * A sub-agent spawned by the harness (Claude's `Task` tool). Its `id` is the
 * spawning tool_use id — the same value the SDK stamps as `parent_tool_use_id`
 * on the sub-agent's own messages, which is how its output is routed here. The
 * sub-agent's activity accrues onto a single rolling assistant `message` via the
 * ordinary `applyStreamEvent` fold. Sub-agents are live-only (never persisted):
 * a tab exists only while the agent runs and is dropped when it finishes.
 */
export const Subagent = Schema.Struct({
  id: Schema.String,
  /** The sub-agent type, e.g. "Explore" / "general-purpose". */
  name: Schema.String,
  /** The short task description passed to the `Task` tool. */
  description: Schema.String,
  status: SubagentStatus,
  message: Message
})
export type Subagent = Schema.Schema.Type<typeof Subagent>

// ── Normalized stream events (the harness-agnostic seam) ──────────────────────

/**
 * When set, this content event belongs to a spawned sub-agent (the harness's
 * `Task` tool), not the main turn — it routes into that sub-agent's own rolling
 * transcript (see `applySubagentEvent`) instead of the main assistant message.
 * The id is the spawning tool_use id (`parent_tool_use_id` on the SDK message).
 */
const AgentId = Schema.optional(Schema.String)

export const StreamEvent = Schema.Union(
  Schema.TaggedStruct("Started", {
    sessionId: Schema.String,
    /** The actual model the harness is running, when known (from init). */
    model: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("Thinking", {
    text: Schema.String,
    seconds: Schema.NullOr(Schema.Number),
    done: Schema.Boolean,
    agentId: AgentId
  }),
  Schema.TaggedStruct("Assistant", { text: Schema.String, agentId: AgentId }),
  Schema.TaggedStruct("ToolStart", {
    id: Schema.String,
    name: Schema.String,
    target: Schema.NullOr(Schema.String),
    agentId: AgentId
  }),
  Schema.TaggedStruct("ToolEnd", {
    id: Schema.String,
    status: ToolStatus,
    meta: Schema.NullOr(Schema.String),
    diff: Schema.NullOr(DiffStat),
    preview: Schema.NullOr(Schema.String),
    agentId: AgentId
  }),
  Schema.TaggedStruct("GateRequested", { gate: ApprovalGate }),
  Schema.TaggedStruct("QuestionRequested", { request: QuestionRequest }),
  /** The agent proposed a plan (ExitPlanMode) — appends a new interactive Plan part. */
  Schema.TaggedStruct("PlanProposed", { plan: Plan }),
  /** A runner-authoritative update to an existing plan (comment/routed/status sync). */
  Schema.TaggedStruct("PlanUpdated", { plan: Plan }),
  /** A harness sub-agent (`Task`) was spawned — opens a live, watch-only tab. */
  Schema.TaggedStruct("SubagentStarted", {
    id: Schema.String,
    name: Schema.String,
    description: Schema.String
  }),
  /** A spawned sub-agent finished — its tab is removed (transcripts are live-only). */
  Schema.TaggedStruct("SubagentEnded", { id: Schema.String, status: SubagentStatus }),
  Schema.TaggedStruct("Done", { costUsd: Schema.Number, tokens: Schema.Number }),
  Schema.TaggedStruct("Failed", { message: Schema.String })
)
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>

// ── Constructors & fold ──────────────────────────────────────────────────────

/** A fresh user turn (already complete), optionally carrying attached images. */
export const userMessage = (
  id: string,
  text: string,
  createdAt: string,
  images: ReadonlyArray<Attachment> = []
): Message => ({
  id,
  role: "user",
  parts: [
    ...images.map((attachment) => ({ _tag: "Image" as const, attachment })),
    ...(text.length > 0 ? [{ _tag: "Text" as const, text }] : [])
  ],
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

/**
 * Settle a persisted message for display when NO live run is attached — i.e. a
 * fresh transcript load. Beyond clearing streaming flags (`settleStreaming`), it
 * resolves orphaned interactive parts: the runner that held their unblocking
 * `Deferred` died with the previous process, so a still-`pending` gate or an
 * unanswered question can never be resumed. A pending gate becomes `rejected`
 * (its command never ran) and a pending question is marked answered-with-nothing,
 * so neither renders dead approve/deny buttons the user could click to no effect.
 * Returns the same object when there is nothing to settle.
 */
export const settleLoaded = (msg: Message): Message => {
  const base = settleStreaming(msg)
  const orphaned = base.parts.some(
    (p) =>
      (p._tag === "Gate" && p.gate.status === "pending") ||
      (p._tag === "Question" && p.answers === null) ||
      (p._tag === "Plan" && (p.plan.status === "proposed" || p.plan.status === "revising"))
  )
  if (!orphaned) return base
  return {
    ...base,
    parts: base.parts.map((p) => {
      if (p._tag === "Gate" && p.gate.status === "pending") {
        return { ...p, gate: { ...p.gate, status: "rejected" as const } }
      }
      if (p._tag === "Question" && p.answers === null) {
        return { ...p, answers: [] as ReadonlyArray<QuestionAnswer> }
      }
      if (p._tag === "Plan" && (p.plan.status === "proposed" || p.plan.status === "revising")) {
        return { ...p, plan: { ...p.plan, status: "stale" as const } }
      }
      return p
    })
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

    Match.tag("PlanProposed", (e) => {
      const part: PlanPart = { _tag: "Plan", plan: e.plan }
      return { ...msg, parts: [...parts, part] }
    }),

    Match.tag("PlanUpdated", (e) => ({
      ...msg,
      parts: parts.map((p): ContentPart =>
        p._tag === "Plan" && p.plan.id === e.plan.id ? { _tag: "Plan", plan: e.plan } : p
      )
    })),

    Match.tag("Done", () => ({ ...msg, streaming: false })),

    Match.tag("Failed", (e) => {
      const part: TextPart = { _tag: "Text", text: e.message }
      return { ...msg, streaming: false, parts: [...parts, part] }
    }),

    // Sub-agent lifecycle events are conversation-level, not part of any single
    // turn — callers route them via `applySubagentEvent`. Ignored here so the
    // fold stays total even if one ever reaches the main message.
    Match.tag("SubagentStarted", () => msg),
    Match.tag("SubagentEnded", () => msg),

    Match.exhaustive
  )
}

/**
 * True when a `StreamEvent` belongs to a spawned sub-agent rather than the main
 * turn — either a sub-agent lifecycle event, or a content event tagged with an
 * `agentId`. Callers use this to route such events into `applySubagentEvent`
 * (and to keep them out of the persisted main transcript).
 */
export const isSubagentEvent = (event: StreamEvent): boolean =>
  event._tag === "SubagentStarted" ||
  event._tag === "SubagentEnded" ||
  ("agentId" in event && event.agentId != null)

/**
 * Fold one sub-agent-scoped `StreamEvent` into the live sub-agent list, returning
 * a new list. `SubagentStarted` opens a fresh watch-only tab; `SubagentEnded`
 * removes it (transcripts are live-only); a content event tagged with `agentId`
 * accrues onto the matching sub-agent's rolling message via `applyStreamEvent`.
 * Events for an unknown id are ignored. Non-sub-agent events pass through
 * unchanged, so callers can route unconditionally.
 */
export const applySubagentEvent = (
  subagents: ReadonlyArray<Subagent>,
  event: StreamEvent
): ReadonlyArray<Subagent> => {
  if (event._tag === "SubagentStarted") {
    if (subagents.some((s) => s.id === event.id)) return subagents
    return [
      ...subagents,
      {
        id: event.id,
        name: event.name,
        description: event.description,
        status: "working",
        message: assistantMessage(event.id, "")
      }
    ]
  }
  if (event._tag === "SubagentEnded") {
    return subagents.filter((s) => s.id !== event.id)
  }
  if ("agentId" in event && event.agentId != null) {
    const agentId = event.agentId
    // Unknown id (e.g. a nested sub-agent, unsupported in MVP) — leave the list
    // untouched so the renderer doesn't re-render on an event it can't place.
    if (!subagents.some((s) => s.id === agentId)) return subagents
    return subagents.map((s) =>
      s.id === agentId ? { ...s, message: applyStreamEvent(s.message, event) } : s
    )
  }
  return subagents
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

const mapPlan = (msg: Message, planId: string, f: (plan: Plan) => Plan): Message => ({
  ...msg,
  parts: msg.parts.map((p): ContentPart =>
    p._tag === "Plan" && p.plan.id === planId ? { _tag: "Plan", plan: f(p.plan) } : p
  )
})

/** Set a plan part's overall status (proposed → revising → approved/rejected/stale). */
export const setPlanStatus = (msg: Message, planId: string, status: PlanStatus): Message =>
  mapPlan(msg, planId, (plan) => ({ ...plan, status }))

/** Set one step's status within a plan (e.g. the step under revision). */
export const setPlanStepStatus = (
  msg: Message,
  planId: string,
  stepId: string,
  status: PlanStepStatus
): Message =>
  mapPlan(msg, planId, (plan) => ({
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, status } : s))
  }))

/** Append a comment to a plan and flag its target step. */
export const addPlanComment = (msg: Message, planId: string, comment: PlanComment): Message =>
  mapPlan(msg, planId, (plan) => ({
    ...plan,
    comments: [...plan.comments, comment],
    steps: plan.steps.map((s) => (s.id === comment.stepId ? { ...s, flagged: true } : s))
  }))

/** The latest still-open plan (proposed or revising) across a transcript, or null. */
export const pendingPlan = (messages: ReadonlyArray<Message>): Plan | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!
      if (part._tag === "Plan" && (part.plan.status === "proposed" || part.plan.status === "revising")) {
        return part.plan
      }
    }
  }
  return null
}

/**
 * The latest plan of ANY status across a transcript, or null. Drives the Plan
 * Review view, which keeps showing an approved/stale plan read-only (unlike
 * `pendingPlan`, which is only the currently-actionable one).
 */
export const latestPlan = (messages: ReadonlyArray<Message>): Plan | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!
      if (part._tag === "Plan") return part.plan
    }
  }
  return null
}

/**
 * The prompt that re-drives an approved plan as a fresh execution turn. Used when
 * approving a plan whose original run is gone (e.g. after an app restart): the
 * resumed harness has no memory of the planning conversation, so the plan is
 * embedded here in full. Deterministic given the plan.
 */
export const resumePlanPrompt = (plan: Plan): string => {
  const steps = plan.steps
    .filter((s) => s.kind !== "branch-arm")
    .map((s) => `${s.number}. ${s.title}${s.intent ? ` — ${s.intent}` : ""}`)
    .join("\n")
  return [
    "The plan below was approved. Implement it now — make the actual code changes and run what's needed.",
    "Do NOT re-plan or ask to enter plan mode again; proceed with the implementation.",
    "",
    `Plan: ${plan.summary}`,
    ...(steps ? ["", "Steps:", steps] : []),
    ...(plan.raw ? ["", "Full plan:", plan.raw] : [])
  ].join("\n")
}
