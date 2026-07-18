import type { PrFileChange, PrReviewThread, ReviewFinding } from "@starbase/core"

/**
 * How much feedback each changed file carries — the number behind the comment
 * icon in the Code Review file list, and the predicate behind its filter.
 *
 * "Feedback" deliberately spans all three sources a reader would count as
 * something-to-look-at on a file:
 *
 *  - **findings** the adversarial reviewer anchored there,
 *  - **drafts** you've written but not yet submitted,
 *  - **threads** already on the PR (GitHub's, a human's, another bot's).
 *
 * Counting only findings would make the icon lie the moment a human reviewer
 * left a comment. They're summed rather than shown separately because the icon
 * answers one question — "is there anything on this file?" — and the file's own
 * sections answer the rest.
 */

export interface FeedbackCounts {
  /** Per-path totals. A path absent from the map has no feedback. */
  readonly byPath: ReadonlyMap<string, number>
  /** Whether ANY file has feedback — drives the filter's disabled state. */
  readonly any: boolean
}

const bump = (map: Map<string, number>, path: string): void => {
  map.set(path, (map.get(path) ?? 0) + 1)
}

/**
 * Count feedback per path, across `files` only.
 *
 * Scoped to the diff's files on purpose: a finding the reviewer anchored to a
 * file it merely READ for context (a real thing — it's told to go and look
 * before claiming duplication) has no row to attach to. Those are surfaced in
 * the view's "general" group instead, so counting them here would inflate a
 * total that no row explains.
 */
export const feedbackCounts = (input: {
  readonly files: readonly PrFileChange[]
  readonly findings: readonly ReviewFinding[]
  readonly drafts: readonly { readonly path: string }[]
  readonly threads: readonly PrReviewThread[]
}): FeedbackCounts => {
  const known = new Set(input.files.map((f) => f.path))
  const byPath = new Map<string, number>()

  for (const finding of input.findings) {
    if (finding.path !== null && known.has(finding.path)) bump(byPath, finding.path)
  }
  for (const draft of input.drafts) {
    if (known.has(draft.path)) bump(byPath, draft.path)
  }
  for (const thread of input.threads) {
    // A resolved thread is settled — counting it would keep a file flagged for
    // attention it no longer needs, and the filter would never empty out.
    if (!thread.isResolved && known.has(thread.path)) bump(byPath, thread.path)
  }

  return { byPath, any: byPath.size > 0 }
}
