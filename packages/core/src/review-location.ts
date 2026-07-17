import type { ReviewFinding } from "./domain.js"

/**
 * How a finding's location is named to a human.
 *
 * Lives in core for the same reason `review-policy.ts` does: this string is the
 * one thing all three surfaces of a review say about WHERE a finding is, and
 * they are read against each other. The finding card in the Code Review pane,
 * the bullet in the PR review body, and the batch prompt handed to the agent all
 * name the same location — a reader comparing the card to the comment GitHub
 * shows them should not have to work out whether `foo.ts:12–14` and `foo.ts:12-14`
 * are the same place. One formatter, three callers, no drift.
 *
 * The separator is an EN DASH (U+2013), not a hyphen — a hyphen reads as part of
 * a filename, and it is exactly the kind of detail a fourth hand-rolled copy
 * would get wrong.
 */

/**
 * `path:line–endLine`, `path:line`, or `path` — and null when the finding is
 * about the change as a whole rather than any one place in it.
 *
 * Callers wrap this as their medium wants (backticks in markdown, a `title`
 * attribute in the UI); the string itself is deliberately unadorned.
 */
export const findingLocation = (finding: ReviewFinding): string | null => {
  if (finding.path === null) return null
  if (finding.line === null) return finding.path
  return finding.endLine === null
    ? `${finding.path}:${finding.line}`
    : `${finding.path}:${finding.line}–${finding.endLine}`
}
