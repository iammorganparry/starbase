import type { AdversarialReview, ReviewFinding } from "@starbase/core"
import { findingLocation, partitionFindings } from "@starbase/core"
import { postableLines } from "./gh.js"

/**
 * Turning a review's minor/nit half into ONE GitHub review payload.
 *
 * Pure, and separate from the `Review.run` handler on purpose: the interesting
 * behaviour here is entirely about which findings can be anchored and what
 * happens to the ones that can't, and that deserves to be testable without a
 * `gh` binary, a worktree, or an agent in sight.
 */

/** One inline comment's markdown body. */
export const commentBody = (finding: ReviewFinding): string => {
  const parts = [`**${finding.severity}** — ${finding.title}`, "", finding.rationale]
  if (finding.suggestion !== null) {
    parts.push("", `**Suggested fix:** ${finding.suggestion}`)
  }
  return parts.join("\n")
}

/** A finding rendered as a bullet for the review body (the un-anchorable ones). */
const bodyBullet = (finding: ReviewFinding): string => {
  const where = findingLocation(finding)
  const head = `- **${finding.severity}**${
    where === null ? "" : ` \`${where}\``
  } — ${finding.title}`
  const why = `  ${finding.rationale}`
  return finding.suggestion === null
    ? `${head}\n${why}`
    : `${head}\n${why}\n  _Suggested fix:_ ${finding.suggestion}`
}

export interface ReviewPostPlan {
  /** Inline comments, each anchored to a line GitHub will accept. */
  readonly comments: ReadonlyArray<{
    readonly path: string
    readonly line: number
    readonly startLine: number | null
    readonly body: string
  }>
  /** The review's top-level body — the summary, plus any findings that wouldn't anchor. */
  readonly body: string
  /** How many findings couldn't be anchored and were folded into `body`. */
  readonly unanchoredCount: number
}

/**
 * Plan the PR post for `review`, given the `diff` it was argued against.
 *
 * Returns null when there is nothing to post — no minor/nit findings at all.
 * That is distinct from "findings, but none anchored": those still post, as a
 * body-only review, because the words are the valuable part and a line number is
 * a convenience.
 *
 * A finding is anchored only if `postableLines` says its line is on the diff's
 * NEW side. Everything else — no path, no line, a path outside the diff, a line
 * the model got wrong — folds into the body rather than being dropped or, worse,
 * being sent anyway and 422-ing the whole review.
 */
export const planReviewPost = (
  review: AdversarialReview,
  diff: string
): ReviewPostPlan | null => {
  const { toPr } = partitionFindings(review.findings)
  if (toPr.length === 0) return null

  const postable = postableLines(diff)
  const comments: Array<ReviewPostPlan["comments"][number]> = []
  const unanchored: Array<ReviewFinding> = []

  for (const finding of toPr) {
    const lines = finding.path === null ? undefined : postable.get(finding.path)
    if (finding.path === null || finding.line === null || !lines?.has(finding.line)) {
      unanchored.push(finding)
      continue
    }
    // GitHub anchors a multi-line comment at the range's END (`line`), with
    // `start_line` above it — the inverse of how the domain names them. Send the
    // range only when BOTH ends are in the diff: `start_line` is validated as
    // strictly as `line`, so a half-valid range takes the whole review down.
    // Otherwise degrade to a single-line comment on the line we know is good.
    const isRange =
      finding.endLine !== null && finding.endLine > finding.line && lines.has(finding.endLine)
    comments.push({
      path: finding.path,
      line: isRange ? finding.endLine! : finding.line,
      startLine: isRange ? finding.line : null,
      body: commentBody(finding)
    })
  }

  const summary = [
    `**Adversarial review** — ${toPr.length} low-severity ${
      toPr.length === 1 ? "finding" : "findings"
    } from \`${review.model}\`.`,
    "",
    "Critical and major findings (if any) went straight to the agent rather than here."
  ]
  if (unanchored.length > 0) {
    summary.push(
      "",
      `<details><summary>${unanchored.length} finding${
        unanchored.length === 1 ? "" : "s"
      } that couldn't be anchored to a line in this diff</summary>`,
      "",
      ...unanchored.map(bodyBullet),
      "",
      "</details>"
    )
  }

  return { comments, body: summary.join("\n"), unanchoredCount: unanchored.length }
}
