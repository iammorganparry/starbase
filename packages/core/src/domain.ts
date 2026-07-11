import { Schema } from "effect"

/**
 * Domain schemas for Starbase. These are Effect `Schema`s so they can be reused
 * for RPC payload encode/decode, persistence, and runtime validation. The plain
 * TypeScript types are derived from the schemas via `Schema.Schema.Type`.
 */

// ── CLI discovery ────────────────────────────────────────────────────────────

/** The coding CLIs Starbase knows how to wrap. */
export const CliKind = Schema.Literal("claude", "codex", "cursor")
export type CliKind = Schema.Schema.Type<typeof CliKind>

/** The outcome of probing for one CLI on the host. */
export const CliInfo = Schema.Struct({
  kind: CliKind,
  /** Human label, e.g. "Claude Code". */
  label: Schema.String,
  /** Resolved absolute path to the binary, or null when not found. */
  binPath: Schema.NullOr(Schema.String),
  /** Reported version string, or null when unknown / unavailable. */
  version: Schema.NullOr(Schema.String),
  available: Schema.Boolean
})
export type CliInfo = Schema.Schema.Type<typeof CliInfo>

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Lifecycle status of an agent session, mirrored in the sidebar pills. */
export const SessionStatus = Schema.Literal(
  "thinking",
  "running",
  "needs-input",
  "idle",
  "done"
)
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>

/** Added / removed line counts for a session's working diff. */
export const DiffStat = Schema.Struct({
  added: Schema.Number,
  removed: Schema.Number
})
export type DiffStat = Schema.Schema.Type<typeof DiffStat>

/** A single agent session shown in the sidebar and opened in the main pane. */
export const Session = Schema.Struct({
  id: Schema.String,
  /** owner/repo, e.g. "trigify/api". */
  repo: Schema.String,
  branch: Schema.String,
  title: Schema.String,
  status: SessionStatus,
  /** Which CLI is driving this session. */
  cli: CliKind,
  diff: DiffStat,
  /** Optional linked pull-request number. */
  prNumber: Schema.NullOr(Schema.Number),
  costUsd: Schema.Number,
  tokens: Schema.Number,
  /** ISO-8601 last-activity timestamp. */
  updatedAt: Schema.String
})
export type Session = Schema.Schema.Type<typeof Session>

// ── Conversation ─────────────────────────────────────────────────────────────

export const MessageRole = Schema.Literal("user", "assistant")
export type MessageRole = Schema.Schema.Type<typeof MessageRole>

/** A tool invocation rendered as a card in the conversation. */
export const ToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** e.g. "src/auth/refresh.ts" — the primary target of the tool call. */
  target: Schema.NullOr(Schema.String),
  summary: Schema.String,
  diff: Schema.NullOr(DiffStat)
})
export type ToolCall = Schema.Schema.Type<typeof ToolCall>

/** An approval gate that pauses the agent for a human decision (HITL). */
export const ApprovalGate = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  status: Schema.Literal("pending", "approved", "rejected")
})
export type ApprovalGate = Schema.Schema.Type<typeof ApprovalGate>

/** One turn in the conversation transcript. */
export const Message = Schema.Struct({
  id: Schema.String,
  role: MessageRole,
  /** Free-text body of the turn. */
  text: Schema.String,
  /** Optional collapsed "thinking" content for assistant turns. */
  thinking: Schema.NullOr(Schema.String),
  /** Tool calls attached to this turn, in order. */
  toolCalls: Schema.Array(ToolCall),
  /** Approval gate attached to this turn, if any. */
  gate: Schema.NullOr(ApprovalGate)
})
export type Message = Schema.Schema.Type<typeof Message>
