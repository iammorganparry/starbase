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

/** Something that wants to be anchored to a line in the diff. */
export interface Anchorable {
  readonly path: string | null
  /** 1-indexed line on the NEW side, or null when not line-anchored. */
  readonly line: number | null
  /** End of a multi-line range, or null for a single line. */
  readonly endLine: number | null
}

/** One anchored comment's position, ready for `prReviewComments`. */
export interface AnchoredAt {
  readonly path: string
  readonly line: number
  readonly startLine: number | null
}

/**
 * Split `items` into those that can be anchored to a line GitHub will accept and
 * those that cannot, given the `diff` they were written against.
 *
 * Shared by the adversarial reviewer's auto-post and the reviewer's own drafts,
 * because getting this wrong is all-or-nothing: GitHub rejects the ENTIRE review
 * when a single comment names a line that isn't on the diff's NEW side, rather
 * than dropping the offending comment. Callers decide what to do with the
 * unanchored half — both currently fold it into the review body.
 */
export const anchorInDiff = <T extends Anchorable>(
  items: readonly T[],
  diff: string
): { readonly anchored: ReadonlyArray<{ readonly item: T; readonly at: AnchoredAt }>; readonly unanchored: ReadonlyArray<T> } => {
  const postable = postableLines(diff)
  const anchored: Array<{ item: T; at: AnchoredAt }> = []
  const unanchored: Array<T> = []

  for (const item of items) {
    const lines = item.path === null ? undefined : postable.get(item.path)
    if (item.path === null || item.line === null || !lines?.has(item.line)) {
      unanchored.push(item)
      continue
    }
    // GitHub anchors a multi-line comment at the range's END (`line`), with
    // `start_line` above it — the inverse of how the domain names them. Send the
    // range only when BOTH ends are in the diff: `start_line` is validated as
    // strictly as `line`, so a half-valid range takes the whole review down.
    // Otherwise degrade to a single-line comment on the line we know is good.
    const isRange = item.endLine !== null && item.endLine > item.line && lines.has(item.endLine)
    anchored.push({
      item,
      at: {
        path: item.path,
        line: isRange ? item.endLine! : item.line,
        startLine: isRange ? item.line : null
      }
    })
  }

  return { anchored, unanchored }
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

  const { anchored, unanchored } = anchorInDiff(toPr, diff)
  const comments = anchored.map(({ item, at }) => ({ ...at, body: commentBody(item) }))

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

/** A draft as it arrives from the renderer — already end-anchored (`line` is the range end). */
interface DraftComment {
  readonly path: string
  readonly line: number
  readonly startLine: number | null
  readonly body: string
}

/** A draft rendered as a bullet for the review body (the un-anchorable ones). */
const draftBullet = (d: DraftComment): string => {
  const where =
    d.startLine !== null && d.startLine < d.line
      ? `${d.path}:${d.startLine}-${d.line}`
      : `${d.path}:${d.line}`
  return `- \`${where}\` — ${d.body}`
}

/**
 * Plan the PR post for the reviewer's own drafts, given the `diff` they were
 * written against.
 *
 * Returns null when there is nothing to post. Mirrors `planReviewPost`'s
 * anchor-or-fold contract: a draft whose line has since moved off the diff keeps
 * its words (folded into the body with a `path:line` prefix) rather than being
 * dropped or 422-ing the whole review.
 *
 * Note the argument order flip vs the domain: drafts arrive with `line` as the
 * range END already (see `ReviewComment`), so `endLine` is `line` and the range
 * start is `startLine` — the inverse of `ReviewFinding`.
 */
export const planDraftPost = (
  drafts: readonly DraftComment[],
  diff: string
): ReviewPostPlan | null => {
  if (drafts.length === 0) return null

  const { anchored, unanchored } = anchorInDiff(
    // Re-express each draft in `Anchorable`'s start→end orientation so the shared
    // helper's range logic (and its both-ends-must-be-postable guard) applies.
    drafts.map((d) => ({ ...d, line: d.startLine ?? d.line, endLine: d.line })),
    diff
  )
  const comments = anchored.map(({ item, at }) => ({ ...at, body: item.body }))

  const summary = ["**Code review**"]
  if (unanchored.length > 0) {
    summary.push(
      "",
      `${unanchored.length} comment${unanchored.length === 1 ? "" : "s"} that couldn't be anchored to a line in this diff:`,
      "",
      ...unanchored.map((d) => draftBullet({ ...d, line: d.endLine, startLine: d.startLine }))
    )
  }

  return { comments, body: summary.join("\n"), unanchoredCount: unanchored.length }
}
