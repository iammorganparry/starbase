import type { TaskKind } from "./task-kind.js"

/**
 * Curated starting beliefs about which lab suits which kind of work.
 *
 * These are PRIORS, not truths, and the distinction is the whole point. A
 * hardcoded routing table goes stale the moment a model ships — which is exactly
 * the argument against the table this file could otherwise become. What stops
 * that here is that evidence overrides them: a prior is what the knowledge base
 * says when it has nothing, and it is labelled as such all the way to the UI so
 * a cold-start guess never reads like a measurement.
 *
 * Deliberately coarse — VENDOR level, not model. A model-level prior would be
 * obsolete within a release and would also compete with the evidence we can
 * actually gather; a vendor-level lean is both more durable and more honest
 * about how much we really know before observing anything.
 *
 * Values are on the same normalised (0, 1) scale as `normaliseScore`, so a prior
 * and an observation are directly comparable. 0.5 is "no opinion".
 */

const NEUTRAL = 0.5

/**
 * Vendor leanings per task kind. Absent means no opinion, which is the honest
 * default for most cells — inventing a lean we cannot justify would just be
 * noise dressed as knowledge.
 */
const PRIORS: Readonly<Partial<Record<TaskKind, Readonly<Record<string, number>>>>> = {
  schema: { anthropic: 0.55, openai: 0.58 },
  tests: { anthropic: 0.57, openai: 0.55 },
  refactor: { anthropic: 0.58, openai: 0.54 },
  docs: { anthropic: 0.58, openai: 0.52 },
  review: { anthropic: 0.58, openai: 0.55 }
}

/** The starting belief for a vendor on a kind of work. */
export const priorFor = (taskKind: TaskKind, vendor: string): number =>
  PRIORS[taskKind]?.[vendor] ?? NEUTRAL

/** Whether we hold any real opinion here, or are just returning neutral. */
export const hasPrior = (taskKind: TaskKind, vendor: string): boolean =>
  PRIORS[taskKind]?.[vendor] !== undefined
