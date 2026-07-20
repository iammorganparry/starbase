import { Schema } from "effect"
import { Plan, PlanChallenge, PlanParticipant } from "./conversation.js"

/**
 * An adversarial planning round: one flagship proposes a plan, a model from a
 * DIFFERENT lab attacks it, and the proposer answers.
 *
 * Persisted per session so a plan can be re-read — and, more importantly,
 * audited — without paying for the round again. The interesting question when
 * reading one back is never "what did it decide" (that's the plan) but "did the
 * critic actually attack, and did the proposer engage or cave?", so the round
 * keeps the critique and the pre-revision proposal rather than only the result.
 */

/**
 * How a round finished. Four outcomes, not two, because the failure modes are
 * the whole risk of the feature and collapsing them would hide both:
 *
 *  - `revised`      — attacked, and the proposer answered. The intended path.
 *  - `clean`        — the adversary examined the plan and raised nothing.
 *  - `unchallenged` — the adversary never ran (offline, missing, errored).
 *
 * `clean` and `unchallenged` must never merge. One says a rival lab read this
 * and found nothing; the other says nobody looked. Presenting the second as the
 * first is the single most misleading thing this feature could do.
 */
export const PlanRoundOutcome = Schema.Literal("revised", "clean", "unchallenged")
export type PlanRoundOutcome = Schema.Schema.Type<typeof PlanRoundOutcome>

/** What the adversary came back with. */
export const PlanCritique = Schema.Struct({
  by: PlanParticipant,
  /**
   * Every challenge raised, including ones not tied to a single step (sequencing
   * across steps, a missing step, a wrong overall shape). Step-scoped challenges
   * are ALSO projected onto their `PlanStep.challenges` for rendering; this is
   * the complete record.
   */
  challenges: Schema.Array(PlanChallenge),
  /**
   * The step each challenge attacks, by step id — parallel to `challenges`, with
   * null for a plan-level objection. Kept beside rather than inside
   * `PlanChallenge` so the step-scoped projection doesn't carry a redundant
   * pointer back to the step it already lives on.
   */
  targets: Schema.Array(Schema.NullOr(Schema.String)),
  /**
   * Set when the adversary answered but produced nothing parseable — a refusal,
   * a bare "looks good", malformed output. Carries the raw text so a human sees
   * *something* rather than an empty list that reads like a clean bill of health.
   */
  note: Schema.NullOr(Schema.String)
})
export type PlanCritique = Schema.Schema.Type<typeof PlanCritique>

export const PlanRound = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.String,
  proposer: PlanParticipant,
  /** Null when no second vendor was reachable and the round ran unchallenged. */
  adversary: Schema.NullOr(PlanParticipant),
  /** The plan as first written, before any critique. Kept so the revision is auditable. */
  proposal: Plan,
  critique: Schema.NullOr(PlanCritique),
  /** The plan after the proposer answered; null unless the outcome is `revised`. */
  revised: Schema.NullOr(Plan),
  outcome: PlanRoundOutcome
})
export type PlanRound = Schema.Schema.Type<typeof PlanRound>

/** The plan a round settled on — the revision when there was one, else the proposal. */
export const settledPlan = (round: PlanRound): Plan => round.revised ?? round.proposal

/**
 * Whether a round's plan carries a rival lab's scrutiny. False for
 * `unchallenged`, so callers can't accidentally present an unreviewed plan as a
 * reviewed one — the distinction `PlanRoundOutcome` exists to preserve.
 */
export const wasScrutinised = (round: PlanRound): boolean => round.outcome !== "unchallenged"
