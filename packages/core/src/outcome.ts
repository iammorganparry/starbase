import { Schema } from "effect"
import { CliKind, ReviewSeverity } from "./domain.js"
import { TaskKind } from "./task-kind.js"

/**
 * What actually happened to a piece of work, scored so the knowledge base can
 * learn which model suits which kind of task in this repository.
 *
 * Every field is a closed literal, a number, or an id we mint. There is
 * deliberately NO free-text field anywhere in this schema, and a test asserts
 * that structurally.
 *
 * The reason is forward-looking rather than paranoid: outcomes are local today,
 * but the moment anything exports or pools them, prose is what leaks. Step
 * titles are model-written and routinely carry proprietary detail ("Migrate the
 * Acme billing export"); a rationale would quote the code. Making the shape safe
 * by construction means a future sharing feature cannot leak by omission — you
 * would have to add a field, and the test would stop you.
 *
 * `sizeBucket` for the same reason: raw line counts near-uniquely fingerprint a
 * change, while a bucket carries the signal (was this big?) with none of the
 * identity.
 */

/** Coarse size of the change an outcome covers. */
export const SizeBucket = Schema.Literal("xs", "s", "m", "l", "xl")
export type SizeBucket = Schema.Schema.Type<typeof SizeBucket>

/** Line-delta thresholds for `SizeBucket`. Shared so callers can't disagree. */
export const sizeBucketFor = (lines: number): SizeBucket =>
  lines <= 10 ? "xs" : lines <= 50 ? "s" : lines <= 200 ? "m" : lines <= 600 ? "l" : "xl"

/**
 * How confidently an outcome was tied to the model that caused it.
 *
 * `exact` — one step owned the changed files.
 * `ambiguous` — several steps claimed them, so the attribution is a guess.
 *
 * Recorded rather than resolved, because a coin-flip attribution would poison a
 * cell with a confident wrong number. Ambiguous outcomes count for less locally
 * and are excluded from anything shared.
 */
export const AttributionConfidence = Schema.Literal("exact", "ambiguous")
export type AttributionConfidence = Schema.Schema.Type<typeof AttributionConfidence>

/** The deterministic signals an outcome is scored from. All already produced by the app. */
export const OutcomeSignals = Schema.Struct({
  findingsCritical: Schema.Number,
  findingsMajor: Schema.Number,
  findingsMinor: Schema.Number,
  findingsNit: Schema.Number,
  /** Null when no CI ever reported — distinct from failing. */
  ciPassed: Schema.NullOr(Schema.Boolean),
  /** Null while the PR is still open — distinct from closed-unmerged. */
  merged: Schema.NullOr(Schema.Boolean),
  /** Files the human reverted — the most direct rejection signal there is. */
  filesReverted: Schema.Number,
  /** How many times the plan was sent back before approval. */
  planRevisions: Schema.Number
})
export type OutcomeSignals = Schema.Schema.Type<typeof OutcomeSignals>

export const Outcome = Schema.Struct({
  id: Schema.String,
  /** Hashed repo identity — see `repo-key.ts`. Never the repo's name. */
  repoKey: Schema.String,
  taskKind: TaskKind,
  cli: CliKind,
  vendor: Schema.String,
  /**
   * The RESOLVED model id the harness reported, never an alias.
   *
   * `opus` resolves server-side and its weights change without notice, so a
   * score attached to the alias silently becomes a score for different weights.
   * The `Started` event carries what actually ran.
   */
  model: Schema.String,
  signals: OutcomeSignals,
  sizeBucket: SizeBucket,
  confidence: AttributionConfidence,
  /** The computed score. Stored so a re-weighting can be compared against it. */
  score: Schema.Number,
  /** Day precision. A timestamp plus commit cadence fingerprints a person. */
  occurredOn: Schema.String
})
export type Outcome = Schema.Schema.Type<typeof Outcome>

/** Severity keys, in the order the scorer weights them. */
export const SEVERITY_ORDER: ReadonlyArray<ReviewSeverity> = ["critical", "major", "minor", "nit"]

/** `YYYY-MM-DD` for a date — the only precision an outcome ever records. */
export const dayOf = (date: Date): string => date.toISOString().slice(0, 10)
