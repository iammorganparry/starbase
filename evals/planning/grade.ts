import type { Plan, PlanRound } from "@starbase/core"
import { unresolvedChallenges } from "@starbase/core"
import type { EvalCase } from "./case.js"

/** What one trial of one case produced. */
export interface TrialResult {
  readonly caseId: string
  readonly detected: boolean
  /** Total challenges raised — a noise proxy, not a penalty (see below). */
  readonly challenges: number
  /** Steps the revision deleted that no challenge asked about. */
  readonly capitulations: number
  readonly outcome: PlanRound["outcome"]
}

/**
 * Did the revision quietly drop steps nobody objected to?
 *
 * Capitulation is the failure mode nobody instruments and the one most likely to
 * make this feature actively harmful: a model handed a list of objections tends
 * to "resolve" all of them, including the wrong ones, and a plan degraded to
 * satisfy a bad critique is worse than an unrevised plan. Counting steps that
 * vanished WITHOUT a challenge against them is the cheapest honest proxy.
 */
export const capitulations = (proposal: Plan, revised: Plan | null): number => {
  if (revised === null) return 0
  const challengedNumbers = new Set(
    revised.steps.filter((s) => (s.challenges ?? []).length > 0).map((s) => s.number)
  )
  const survivingTitles = new Set(revised.steps.map((s) => s.title.trim().toLowerCase()))
  return proposal.steps.filter(
    (s) => !survivingTitles.has(s.title.trim().toLowerCase()) && !challengedNumbers.has(s.number)
  ).length
}

export const gradeTrial = (evalCase: EvalCase, round: PlanRound): TrialResult => {
  const challenges = round.critique?.challenges ?? []
  return {
    caseId: evalCase.id,
    detected: evalCase.detected(challenges.map((c) => ({ title: c.title, rationale: c.rationale }))),
    challenges: challenges.length,
    capitulations: capitulations(round.proposal, round.revised),
    outcome: round.outcome
  }
}

export interface PairSummary {
  readonly pair: string
  readonly trials: number
  /** Share of trials where the planted defect was caught. The headline metric. */
  readonly detectionRate: number
  readonly heldOutDetectionRate: number
  /**
   * Mean challenges per trial. Reported, never scored against: a critic may
   * legitimately find real problems we did not plant, and penalising that would
   * train the corpus to reward silence.
   */
  readonly meanChallenges: number
  readonly meanCapitulations: number
  /** Rounds where nobody actually reviewed the plan — a health signal, not quality. */
  readonly unchallenged: number
}

const mean = (xs: ReadonlyArray<number>): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

export const summarise = (
  pair: string,
  results: ReadonlyArray<TrialResult>,
  heldOutIds: ReadonlySet<string>
): PairSummary => {
  const tuned = results.filter((r) => !heldOutIds.has(r.caseId))
  const held = results.filter((r) => heldOutIds.has(r.caseId))
  return {
    pair,
    trials: results.length,
    detectionRate: mean(tuned.map((r) => (r.detected ? 1 : 0))),
    heldOutDetectionRate: mean(held.map((r) => (r.detected ? 1 : 0))),
    meanChallenges: mean(results.map((r) => r.challenges)),
    meanCapitulations: mean(results.map((r) => r.capitulations)),
    unchallenged: results.filter((r) => r.outcome === "unchallenged").length
  }
}

/**
 * How much a run may drift below its baseline before it counts as a regression.
 *
 * Deliberately generous. Model output is noisy, and a threshold that fires on
 * normal variance gets muted — a muted eval is worse than no eval, because it
 * looks like coverage while asserting nothing.
 */
export const REGRESSION_BAND = 0.15

export const isRegression = (current: number, baseline: number): boolean =>
  current < baseline - REGRESSION_BAND

/** Unresolved challenges across a plan — surfaced in the report as review signal. */
export const openChallenges = (plan: Plan): number =>
  plan.steps.reduce((n, s) => n + unresolvedChallenges(s).length, 0)
