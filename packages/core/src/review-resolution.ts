import type { ReviewFinding } from "./domain.js"

/**
 * Attributing review findings to the commit that fixed them.
 *
 * A review is a snapshot of one PR head. The agent then goes and fixes what it
 * was handed — and until now nothing recorded that, so a card kept reading
 * "Sent to agent" long after the defect was gone. The operator's only way to
 * tell an outstanding finding from a fixed one was to re-read the diff.
 *
 * Nothing asks the agent which finding a commit closes, and nothing reasonably
 * could — it fixes several at once, or fixes one while touching three files. So
 * resolution is INFERRED here, from the one signal that is always available: the
 * commits landed since the reviewed head, and the files each one touched.
 *
 * The rule is deliberately narrow, because a wrong attribution is worse than a
 * missing one — it tells the operator a defect is handled when it is not:
 *
 *  - Only findings anchored to a PATH can resolve. A finding about the change as
 *    a whole has no file to match, and guessing from "some commit happened" would
 *    resolve everything the moment anything landed.
 *  - The FIRST matching commit wins, oldest first. Later edits to the same file
 *    are almost certainly other work; crediting them would make the attribution
 *    drift forwards every time the file is touched again.
 *  - An already-resolved finding is never re-attributed. The resolution is a fact
 *    about the commit that closed it, not about the most recent one.
 *
 * What this deliberately does NOT do is claim certainty. The UI says "Resolved
 * in <sha>" next to a commit the operator can go and read — the attribution is a
 * pointer to evidence, not a verdict, which is the honest shape for a heuristic.
 */

/** One commit landed since the reviewed head, and the files it touched. */
export interface ResolvingCommit {
  /** Full 40-char SHA. */
  readonly sha: string
  /** Subject line — what the card shows beside the hash. */
  readonly subject: string
  /** Repo-relative paths the commit touched. */
  readonly files: ReadonlyArray<string>
}

/**
 * Stamp `resolvedBy` onto each outstanding finding whose file a commit touched.
 *
 * `commits` must be OLDEST FIRST — the order decides which commit gets the
 * credit, so it is part of the contract rather than an implementation detail.
 *
 * Returns the SAME array reference when nothing resolved, so callers can use
 * identity to skip a persist and a re-render.
 */
export const resolveFindings = (
  findings: ReadonlyArray<ReviewFinding>,
  commits: ReadonlyArray<ResolvingCommit>,
  at: string
): ReadonlyArray<ReviewFinding> => {
  if (commits.length === 0) return findings
  let changed = false
  const next = findings.map((finding) => {
    // Already attributed, or nothing to match against.
    if (finding.resolvedBy !== null || finding.path === null) return finding
    const commit = commits.find((c) => c.files.includes(finding.path!))
    if (commit === undefined) return finding
    changed = true
    return { ...finding, resolvedBy: { sha: commit.sha, subject: commit.subject, at } }
  })
  return changed ? next : findings
}

/** How many of these findings have been attributed to a commit. */
export const resolvedCount = (findings: ReadonlyArray<ReviewFinding>): number =>
  findings.reduce((n, f) => (f.resolvedBy === null ? n : n + 1), 0)
