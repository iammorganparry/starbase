/**
 * An eval case: a brief, a tiny repo, and a defect we KNOW is in the plan.
 *
 * You cannot objectively score "is this plan good". You CAN plant a specific
 * problem and measure whether the adversary catches it — and because we planted
 * it, we know exactly what catching it reads like. That makes detection a real
 * number that moves when the prompts change, rather than a vibe.
 *
 * The fixture repo is a set of files rather than a committed git repo: the runner
 * materialises and `git init`s it per trial, so cases stay readable in review and
 * no binary objects live in the tree.
 */

/** The failure modes a plan review is uniquely able to catch, before any code exists. */
export type DefectClass =
  | "ordering"
  | "hidden-coupling"
  | "irreversibility"
  | "test-gap"
  | "convention"
  | "scope-creep"

export interface EvalCase {
  readonly id: string
  readonly defectClass: DefectClass
  /** The task handed to the proposer. */
  readonly brief: string
  /** Repo-relative path → contents. Materialised into a real git repo per trial. */
  readonly fixture: Readonly<Record<string, string>>
  /** What is wrong, in one line — for the report, not the model. */
  readonly defect: string
  /**
   * Did the critique catch it? Deterministic on purpose: free, reproducible, and
   * diffable across runs. An LLM grader would reintroduce the nondeterminism the
   * harness exists to measure against.
   */
  readonly detected: (challenges: ReadonlyArray<{ title: string; rationale: string }>) => boolean
  /**
   * Held-out cases are excluded from prompt iteration and reported separately.
   * Without this split, tuning the adversary until it aces a fixed corpus just
   * teaches it the corpus, and the number stops meaning anything.
   */
  readonly heldOut: boolean
}

/** Match against a challenge's full text — title and rationale together. */
export const mentions = (
  challenges: ReadonlyArray<{ title: string; rationale: string }>,
  ...patterns: ReadonlyArray<RegExp>
): boolean =>
  challenges.some((c) => {
    const text = `${c.title} ${c.rationale}`
    return patterns.every((p) => p.test(text))
  })

export const defineCase = (c: EvalCase): EvalCase => c
