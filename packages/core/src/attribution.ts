import type { AttributionConfidence } from "./outcome.js"
import type { PlanStep } from "./conversation.js"

/**
 * Tying an observed result back to the plan step — and therefore the model —
 * that caused it.
 *
 * This is the weakest joint in the learning loop and it says so rather than
 * pretending otherwise. A review finding names a file; a plan step declares the
 * files it intends to touch; matching one to the other is a heuristic, not a
 * fact. When two steps both claim a file the honest answer is "we don't know
 * which", and the outcome is recorded with reduced confidence instead of a coin
 * flip — a confidently wrong attribution poisons a cell far more than a missing
 * one, because the cell has no way to tell it was wrong.
 */

/** Windows separators → POSIX, so path comparison has one shape to reason about. */
export const normalizePath = (p: string): string => p.replace(/\\/g, "/")

/**
 * Do two paths name the same file? One side is typically an absolute worktree
 * path (a tool's edit target, or a finding's location), the other a
 * repo-relative path (a plan step's declared `files:`), so a suffix match is
 * right — but ONLY anchored at a separator. An unanchored `endsWith` makes
 * "a.ts" match "src/schema.ts" and attributes an outcome to a step that had
 * nothing to do with it.
 */
export const samePath = (a: string, b: string): boolean =>
  a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)

export interface Attribution {
  readonly step: PlanStep
  readonly confidence: AttributionConfidence
}

/**
 * Which step owns `path`, and how sure we are.
 *
 * `exact` when precisely one step declared the file. `ambiguous` when several
 * did — the first is still returned so the outcome is recorded rather than
 * dropped, but flagged so it counts for less and never leaves the machine.
 * Returns null when no step claims it at all: work outside the plan is real, but
 * attributing it to whichever step happens to be nearby would be fabrication.
 */
export const attributePath = (
  steps: ReadonlyArray<PlanStep>,
  path: string
): Attribution | null => {
  const target = normalizePath(path)
  const owners = steps.filter((s) =>
    s.files.some((f) => samePath(target, normalizePath(f.path)))
  )
  if (owners.length === 0) return null
  return { step: owners[0]!, confidence: owners.length === 1 ? "exact" : "ambiguous" }
}

/**
 * Roll several per-path attributions into one verdict for a whole outcome.
 *
 * Any ambiguity anywhere makes the whole thing ambiguous. That is deliberately
 * pessimistic: an outcome is a single score against a single model, so one
 * misattributed file is enough to make the number wrong, and the cost of
 * under-counting confidence is far lower than the cost of a confident error.
 */
export const rollUpConfidence = (
  attributions: ReadonlyArray<Attribution>
): AttributionConfidence =>
  attributions.some((a) => a.confidence === "ambiguous") ? "ambiguous" : "exact"
