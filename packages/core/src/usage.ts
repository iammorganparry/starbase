import { Schema } from "effect"
import { CliKind } from "./domain.js"

/**
 * Provider usage / rate-limit model for the "Usage & limits" widget. Providers
 * expose limited data today — Claude reports each window's reset time + a status
 * (and a utilization % when available) via `rate_limit_event`s captured during
 * runs; other harnesses report nothing yet (`available: false`).
 */

/** How close a window is to its limit. */
export const UsageStatus = Schema.Literal("ok", "nearing", "limited", "unknown")
export type UsageStatus = Schema.Schema.Type<typeof UsageStatus>

/** One rate-limit window (a session or weekly quota). */
export const UsageWindow = Schema.Struct({
  /** e.g. "Current session" / "Weekly · all models" / "Weekly · Opus". */
  label: Schema.String,
  /** ISO-8601 reset time, or null when unknown. */
  resetsAt: Schema.NullOr(Schema.String),
  /** Percentage used (0–100), or null when the provider doesn't report it. */
  utilization: Schema.NullOr(Schema.Number),
  status: UsageStatus
})
export type UsageWindow = Schema.Schema.Type<typeof UsageWindow>

/** A provider's usage: its windows, plus whether we have any data for it. */
export const ProviderUsage = Schema.Struct({
  cli: CliKind,
  name: Schema.String,
  /** Subscription/plan label (e.g. "Max"), or null when unknown. */
  plan: Schema.NullOr(Schema.String),
  /** False → the harness exposes no usage data yet (shown as "not available"). */
  available: Schema.Boolean,
  windows: Schema.Array(UsageWindow)
})
export type ProviderUsage = Schema.Schema.Type<typeof ProviderUsage>

/** The full usage snapshot shown in the modal. */
export const Usage = Schema.Struct({
  providers: Schema.Array(ProviderUsage),
  /** When the data was last captured, or null when never. */
  fetchedAt: Schema.NullOr(Schema.String)
})
export type Usage = Schema.Schema.Type<typeof Usage>
