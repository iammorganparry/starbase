import type { ReviewSeverity } from "./domain.js"
import type { OutcomeSignals } from "./outcome.js"

/**
 * How well did a piece of work go?
 *
 * Pure, total, and free of any clock or IO, so it is a table — the weights below
 * ARE the policy and can be argued with directly rather than being buried in a
 * pipeline.
 *
 * Two properties are load-bearing and enforced by property tests, because the
 * knowledge base is arithmetic and example tests pass straight over broken
 * invariants here:
 *
 *  - **Monotonic in badness.** Adding a finding, or upgrading one's severity,
 *    can never raise a score. A scorer that can be improved by finding MORE
 *    problems would invert the whole loop.
 *  - **Merging never loses to closing.** Two otherwise-identical outcomes rank
 *    by the terminal signal in the obvious direction.
 *
 * The absolute numbers matter far less than the ordering. Nothing consumes a raw
 * score; the knowledge base only ever compares them.
 */

/**
 * Severity weights.
 *
 * A nit is genuinely free — it is the reviewer being thorough, not the work
 * being bad, and charging for it would teach the loop to prefer models that say
 * less. A critical is most of the signal.
 */
const SEVERITY_WEIGHT: Readonly<Record<ReviewSeverity, number>> = {
  critical: -3,
  major: -2,
  minor: -0.5,
  nit: 0
}

/**
 * Terminal and process weights.
 *
 * `merged` is the strongest positive available: a human looked at the work and
 * took it. A revert is weighted close to a major finding because it is the most
 * direct rejection there is — someone read the change and undid it.
 *
 * Plan revisions are charged only lightly. Sending a plan back is the system
 * working, not the model failing, and penalising it heavily would bias the loop
 * toward models that produce plans nobody bothers to argue with.
 */
const MERGED = 3
const CLOSED_UNMERGED = -2
const CI_PASSED = 1
const CI_FAILED = -3
const PER_REVERT = -1.5
const PER_REVISION = -0.25

export const scoreOutcome = (s: OutcomeSignals): number => {
  let score = 0
  score += s.findingsCritical * SEVERITY_WEIGHT.critical
  score += s.findingsMajor * SEVERITY_WEIGHT.major
  score += s.findingsMinor * SEVERITY_WEIGHT.minor
  score += s.findingsNit * SEVERITY_WEIGHT.nit
  // null is "never reported", which is not the same as failing and must not be
  // scored as it — an unbuilt PR is not a broken one.
  if (s.ciPassed === true) score += CI_PASSED
  if (s.ciPassed === false) score += CI_FAILED
  // Likewise: null is "still open", not "closed unmerged".
  if (s.merged === true) score += MERGED
  if (s.merged === false) score += CLOSED_UNMERGED
  score += s.filesReverted * PER_REVERT
  score += s.planRevisions * PER_REVISION
  return score
}

/**
 * Map a raw score onto the OPEN interval (0, 1) for the knowledge base.
 *
 * The KB averages and shrinks estimates, which needs a bounded quantity — an
 * unbounded score lets one catastrophic outcome dominate a cell forever.
 *
 * Clamped strictly inside the interval, and that is not decoration: a plain
 * sigmoid underflows to exactly 0 for a sufficiently bad score (caught by a
 * property test at -1000), which would make every catastrophic outcome
 * indistinguishable from every other and hand a Beta-style posterior a zero it
 * cannot recover from. The exact curve is unimportant; what matters is that it
 * is non-decreasing, so normalising can never REORDER two outcomes.
 */
const EPSILON = 1e-6

export const normaliseScore = (score: number): number => {
  const sigmoid = 1 / (1 + Math.exp(-score / 3))
  return Math.min(1 - EPSILON, Math.max(EPSILON, sigmoid))
}

/** How much an ambiguous attribution counts, relative to an exact one. */
export const AMBIGUOUS_WEIGHT = 0.35

/**
 * How much an LLM judge's verdict may move a score.
 *
 * Deliberately a MINORITY share. The judge exists to see what CI and review
 * findings cannot — was this well-built, or merely merged — but it is one
 * model's opinion, unaudited and uncalibrated. Letting it dominate would swap a
 * loop grounded in observable events for one grounded in a model's taste, which
 * is the failure mode that makes a learning system quietly worthless.
 *
 * Bounded so the deterministic signals always decide the sign of a clear
 * outcome, and the judge only ever adjusts within that.
 */
export const JUDGE_WEIGHT = 0.3

/**
 * Fold a judge's verdict (0–1) into a deterministic score.
 *
 * Null verdict — refused, unparseable, budget exhausted, or simply not enabled —
 * returns the deterministic score unchanged, so an absent judge is exactly
 * equivalent to no judge rather than to a neutral one.
 */
export const withJudgement = (score: number, verdict: number | null): number => {
  if (verdict === null) return score
  // Map the verdict onto the same rough range the deterministic signals occupy,
  // then blend. Centred on 0.5 so an ambivalent judge moves nothing.
  const adjustment = (verdict - 0.5) * 2 * 3
  return score * (1 - JUDGE_WEIGHT) + adjustment * JUDGE_WEIGHT
}
