import type { ReviewFinding, ReviewSeverity } from "./domain.js"

/**
 * Where an adversarial-review finding goes, decided by severity alone.
 *
 * The reviewer is prompted for COVERAGE with honest severity rather than
 * self-filtering (see `review-prompt.ts` — asking it to report only the big ones
 * makes it find bugs, judge them below the bar, and silently drop them). That
 * only pays off if something downstream acts on the severity it hands back. This
 * module is that something: it is the single place severity becomes a
 * destination, shared by the main process (which posts and prompts) and the
 * renderer (which routes and renders).
 *
 * The split is a judgement about who can act:
 *
 *  - **critical / major** go to the session's agent. They describe a defect with
 *    a concrete failure, and the agent is holding the worktree — it can fix them
 *    now, before a human is ever asked to look.
 *  - **minor / nit** go to the PR as inline comments. They are not worth
 *    interrupting the agent's work for, but they are worth saying next to the
 *    line they concern, where a reviewer will read them in context.
 *
 * Every severity in `ReviewSeverity` belongs to exactly one set. That is load
 * bearing rather than incidental: a severity in neither would make findings
 * vanish — not shown as sent, not posted, just silently dropped from both halves
 * of a review the user paid for. `partitionFindings`'s test pins the totals.
 */
export const AGENT_SEVERITIES: ReadonlySet<ReviewSeverity> = new Set<ReviewSeverity>([
  "critical",
  "major"
])

export const PR_SEVERITIES: ReadonlySet<ReviewSeverity> = new Set<ReviewSeverity>([
  "minor",
  "nit"
])

/** Where a single finding is destined. */
export const destinationOf = (severity: ReviewSeverity): "agent" | "pr" =>
  AGENT_SEVERITIES.has(severity) ? "agent" : "pr"

export interface FindingSplit {
  /** Batched into ONE prompt for the session's agent. */
  readonly toAgent: ReadonlyArray<ReviewFinding>
  /** Posted to the PR as inline review comments. */
  readonly toPr: ReadonlyArray<ReviewFinding>
}

/**
 * Split a review's findings into the agent-bound and PR-bound halves.
 *
 * Order within each half is preserved, so a caller that ranked worst-first keeps
 * that ranking.
 */
export const partitionFindings = (findings: ReadonlyArray<ReviewFinding>): FindingSplit => ({
  toAgent: findings.filter((f) => AGENT_SEVERITIES.has(f.severity)),
  toPr: findings.filter((f) => PR_SEVERITIES.has(f.severity))
})
