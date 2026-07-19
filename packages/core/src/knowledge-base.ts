import type { CliKind } from "./domain.js"
import type { Outcome } from "./outcome.js"
import { priorFor } from "./priors.js"
import { AMBIGUOUS_WEIGHT, normaliseScore } from "./score.js"
import type { TaskKind } from "./task-kind.js"

/**
 * Which agent has actually done well at this kind of work, in THIS repository.
 *
 * Entirely pure — outcomes in, ranking out, no clock and no IO. That is not
 * tidiness: the arithmetic here (pooling, decay, exploration) is exactly the
 * kind of code where an example test passes while the invariant is broken, so it
 * has to be drivable by a simulation over hundreds of seeded runs.
 *
 * Four levels, shrinking outward only as far as thin data forces:
 *
 *   repo × kind × model    the sharpest answer, once a cell has real evidence
 *   repo × kind × vendor    the first useful signal, and usually the one in play
 *   any repo × kind × vendor    when this repository is new to you
 *   curated prior           cold start
 *
 * Every answer reports which level produced it, because a recommendation drawn
 * from a prior and one drawn from forty observations are different claims and
 * must not look alike in the UI.
 */

export type AffinityLevel = "repo-model" | "repo-vendor" | "cross-repo" | "prior"

export interface Candidate {
  readonly cli: CliKind
  readonly model: string
  readonly vendor: string
}

export interface Ranked extends Candidate {
  /** Normalised (0, 1) estimate — comparable across levels by construction. */
  readonly estimate: number
  /** Effective observations behind it, after decay and ambiguity weighting. */
  readonly observations: number
  readonly level: AffinityLevel
  /** True when exploration promoted this above its estimate. */
  readonly exploring: boolean
}

export interface AffinityOptions {
  /** Wall clock, injected so the module stays pure and testable. */
  readonly now: Date
  /**
   * Evidence older than this counts for half. Model weights change silently
   * behind an alias, so a year-old result about "opus" may describe different
   * weights entirely — decay is what stops that drift accumulating as fact.
   */
  readonly halfLifeDays?: number
  /**
   * Effective observations at which a cell stops borrowing from the level above.
   * Below it, the estimate is a blend — a cell with two data points is noise, and
   * treating it as knowledge is how early luck becomes permanent.
   */
  readonly confidentAt?: number
  /**
   * Share of calls that promote an under-sampled candidate.
   *
   * Without exploration the ranking freezes: the current best keeps getting
   * picked, the runner-up is never sampled again, and a lucky first result
   * becomes an unfalsifiable fact. Seeded so tests are deterministic.
   */
  readonly explorationRate?: number
  /** Deterministic 0–1 source for exploration. Omit for no exploration. */
  readonly random?: () => number
}

const DEFAULTS = { halfLifeDays: 90, confidentAt: 8, explorationRate: 0.15 }

const DAY_MS = 24 * 60 * 60 * 1000

/** Age-decayed weight of one outcome, also discounted when attribution was unsure. */
const weightOf = (outcome: Outcome, now: Date, halfLifeDays: number): number => {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(outcome.occurredOn)) / DAY_MS)
  const decay = Math.pow(0.5, ageDays / halfLifeDays)
  return decay * (outcome.confidence === "ambiguous" ? AMBIGUOUS_WEIGHT : 1)
}

interface Pool {
  readonly weight: number
  readonly weighted: number
}

const EMPTY: Pool = { weight: 0, weighted: 0 }

const pool = (outcomes: ReadonlyArray<Outcome>, now: Date, halfLifeDays: number): Pool =>
  outcomes.reduce((acc, o) => {
    const w = weightOf(o, now, halfLifeDays)
    return { weight: acc.weight + w, weighted: acc.weighted + w * normaliseScore(o.score) }
  }, EMPTY)

/**
 * Shrink an estimate toward its fallback in proportion to how thin it is.
 *
 * At zero observations the answer is entirely the fallback; at `confidentAt` it
 * is entirely the cell's own. In between it is a blend, which is what stops two
 * lucky results from outranking a well-evidenced alternative.
 */
const shrink = (p: Pool, fallback: number, confidentAt: number): number => {
  if (p.weight === 0) return fallback
  const own = p.weighted / p.weight
  const trust = Math.min(1, p.weight / confidentAt)
  return trust * own + (1 - trust) * fallback
}

/**
 * Rank `candidates` for this repo and task kind.
 *
 * Candidates are supplied by the caller (they come from live discovery), so the
 * knowledge base can never recommend a harness that isn't installed — the
 * ranking has no way to name something it wasn't offered.
 */
export const affinity = (
  input: {
    readonly repoKey: string
    readonly taskKind: TaskKind
    readonly candidates: ReadonlyArray<Candidate>
    /** Every outcome available locally, across all repos. Filtered here. */
    readonly outcomes: ReadonlyArray<Outcome>
  },
  options: AffinityOptions
): ReadonlyArray<Ranked> => {
  const halfLifeDays = options.halfLifeDays ?? DEFAULTS.halfLifeDays
  const confidentAt = options.confidentAt ?? DEFAULTS.confidentAt
  const { now } = options

  const forKind = input.outcomes.filter((o) => o.taskKind === input.taskKind)
  const thisRepo = forKind.filter((o) => o.repoKey === input.repoKey)

  const ranked = input.candidates.map((c): Ranked => {
    const priorValue = priorFor(input.taskKind, c.vendor)
    const crossRepo = pool(
      forKind.filter((o) => o.vendor === c.vendor),
      now,
      halfLifeDays
    )
    const crossEstimate = shrink(crossRepo, priorValue, confidentAt)

    const repoVendor = pool(
      thisRepo.filter((o) => o.vendor === c.vendor),
      now,
      halfLifeDays
    )
    const repoVendorEstimate = shrink(repoVendor, crossEstimate, confidentAt)

    const repoModel = pool(
      thisRepo.filter((o) => o.model === c.model),
      now,
      halfLifeDays
    )
    const estimate = shrink(repoModel, repoVendorEstimate, confidentAt)

    // The level is whichever pool actually carries the answer — the most
    // specific one with real evidence behind it.
    const level: AffinityLevel =
      repoModel.weight >= confidentAt
        ? "repo-model"
        : repoVendor.weight > 0
          ? "repo-vendor"
          : crossRepo.weight > 0
            ? "cross-repo"
            : "prior"

    return {
      ...c,
      estimate,
      observations: Math.round(repoModel.weight * 10) / 10,
      level,
      exploring: false
    }
  })

  const sorted = [...ranked].sort((a, b) => b.estimate - a.estimate)
  return explore(sorted, options)
}

/**
 * Promote the least-sampled candidate to the front, some of the time.
 *
 * Applied AFTER ranking rather than woven into the estimate, so exploration
 * never corrupts the numbers the UI shows — the operator sees the true estimate
 * and a flag saying this pick was a deliberate probe.
 */
const explore = (
  sorted: ReadonlyArray<Ranked>,
  options: AffinityOptions
): ReadonlyArray<Ranked> => {
  const rate = options.explorationRate ?? DEFAULTS.explorationRate
  const random = options.random
  if (random === undefined || sorted.length < 2 || random() >= rate) return sorted
  const thinnest = [...sorted].sort((a, b) => a.observations - b.observations)[0]!
  if (thinnest === sorted[0]) return sorted
  return [
    { ...thinnest, exploring: true },
    ...sorted.filter((c) => c.model !== thinnest.model || c.cli !== thinnest.cli)
  ]
}
