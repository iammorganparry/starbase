import { describe, expect, it } from "vitest"
import type { Candidate } from "./knowledge-base.js"
import { affinity } from "./knowledge-base.js"
import type { Outcome } from "./outcome.js"

const NOW = new Date("2026-07-18T00:00:00.000Z")
const REPO = "repo-a"

const OPUS: Candidate = { cli: "claude", model: "claude-fable-5", vendor: "anthropic" }
const SOL: Candidate = { cli: "codex", model: "gpt-5.6-sol", vendor: "openai" }
const CANDIDATES = [OPUS, SOL]

const daysAgo = (n: number): string =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

let seq = 0
const outcome = (over: Partial<Outcome> & { score: number }): Outcome => ({
  id: `o${seq++}`,
  repoKey: REPO,
  taskKind: "schema",
  cli: "codex",
  vendor: "openai",
  model: "gpt-5.6-sol",
  signals: {
    findingsCritical: 0,
    findingsMajor: 0,
    findingsMinor: 0,
    findingsNit: 0,
    ciPassed: null,
    merged: null,
    filesReverted: 0,
    planRevisions: 0
  },
  sizeBucket: "m",
  confidence: "exact",
  occurredOn: daysAgo(1),
  ...over
})

const many = (n: number, over: Partial<Outcome> & { score: number }): ReadonlyArray<Outcome> =>
  Array.from({ length: n }, () => outcome(over))

const rank = (outcomes: ReadonlyArray<Outcome>, opts: Partial<Parameters<typeof affinity>[1]> = {}) =>
  affinity({ repoKey: REPO, taskKind: "schema", candidates: CANDIDATES, outcomes }, { now: NOW, ...opts })

describe("affinity — levels", () => {
  it("answers from the PRIOR when nothing has been observed", () => {
    // A cold start must say so, or a guess reads like a measurement.
    const out = rank([])
    expect(out.every((r) => r.level === "prior")).toBe(true)
    expect(out.every((r) => r.observations === 0)).toBe(true)
  })

  it("borrows from other repos when this one is new", () => {
    const out = rank(many(6, { score: 6, repoKey: "somewhere-else" }))
    expect(out.find((r) => r.model === SOL.model)?.level).toBe("cross-repo")
  })

  it("uses this repo's vendor evidence once it exists", () => {
    const out = rank(many(3, { score: 6, model: "gpt-5.6-terra" }))
    expect(out.find((r) => r.model === SOL.model)?.level).toBe("repo-vendor")
  })

  it("reaches repo-model only when the cell is genuinely confident", () => {
    expect(rank(many(3, { score: 6 })).find((r) => r.model === SOL.model)?.level).not.toBe(
      "repo-model"
    )
    expect(rank(many(10, { score: 6 })).find((r) => r.model === SOL.model)?.level).toBe("repo-model")
  })

  it("never recommends a candidate it was not offered", () => {
    // The ranking has no way to name a harness that isn't installed.
    const out = rank(many(10, { score: 9, model: "some-other-model", vendor: "moonshot" }))
    expect(out.map((r) => r.model).sort()).toEqual([OPUS.model, SOL.model].sort())
  })
})

describe("affinity — evidence beats priors", () => {
  it("ranks a genuinely better model first", () => {
    const out = rank([
      ...many(10, { score: 8, cli: "codex", vendor: "openai", model: SOL.model }),
      ...many(10, { score: -6, cli: "claude", vendor: "anthropic", model: OPUS.model })
    ])
    expect(out[0]!.model).toBe(SOL.model)
  })

  it("does not let two lucky results outrank a well-evidenced alternative", () => {
    // Shrinkage is what stops early luck becoming permanent.
    const out = rank([
      ...many(2, { score: 10, cli: "claude", vendor: "anthropic", model: OPUS.model }),
      ...many(20, { score: 4, cli: "codex", vendor: "openai", model: SOL.model })
    ])
    expect(out[0]!.model).toBe(SOL.model)
  })
})

describe("affinity — decay", () => {
  it("ranks fresh evidence above stale evidence of the same strength", () => {
    // A year-old result about "opus" may describe entirely different weights.
    const out = rank([
      ...many(10, { score: 8, cli: "claude", vendor: "anthropic", model: OPUS.model, occurredOn: daysAgo(700) }),
      ...many(10, { score: 5, cli: "codex", vendor: "openai", model: SOL.model, occurredOn: daysAgo(1) })
    ])
    expect(out[0]!.model).toBe(SOL.model)
  })

  it("discounts an ambiguous attribution relative to an exact one", () => {
    const exact = rank(many(10, { score: 8 })).find((r) => r.model === SOL.model)!
    const fuzzy = rank(many(10, { score: 8, confidence: "ambiguous" })).find(
      (r) => r.model === SOL.model
    )!
    expect(fuzzy.observations).toBeLessThan(exact.observations)
    expect(fuzzy.estimate).toBeLessThan(exact.estimate)
  })
})

describe("affinity — exploration", () => {
  it("does nothing without an injected source", () => {
    const out = rank(many(10, { score: 8 }))
    expect(out.every((r) => !r.exploring)).toBe(true)
  })

  it("promotes the thinnest candidate and flags it", () => {
    // Without this the ranking freezes: the runner-up is never sampled again and
    // a lucky first result becomes unfalsifiable.
    const out = rank(many(20, { score: 8 }), { random: () => 0, explorationRate: 0.15 })
    expect(out[0]!.model).toBe(OPUS.model)
    expect(out[0]!.exploring).toBe(true)
  })

  it("leaves the ranking alone when the roll misses", () => {
    const out = rank(many(20, { score: 8 }), { random: () => 0.99, explorationRate: 0.15 })
    expect(out[0]!.model).toBe(SOL.model)
    expect(out[0]!.exploring).toBe(false)
  })

  it("never hides the true estimate behind a probe", () => {
    // Exploration is applied after ranking so the UI still shows real numbers.
    const out = rank(many(20, { score: 8 }), { random: () => 0 })
    const promoted = out[0]!
    const natural = rank(many(20, { score: 8 })).find((r) => r.model === promoted.model)!
    expect(promoted.estimate).toBeCloseTo(natural.estimate, 10)
  })
})

describe("affinity — purity", () => {
  it("is deterministic for identical input", () => {
    const outcomes = many(7, { score: 5 })
    expect(rank(outcomes)).toStrictEqual(rank(outcomes))
  })

  it("ignores outcomes for other task kinds", () => {
    const out = rank(many(20, { score: 9, taskKind: "frontend" }))
    expect(out.every((r) => r.level === "prior")).toBe(true)
  })
})

/**
 * A simulation, not an example: define a ground truth, generate outcomes from
 * it, and check the real ranking finds it. This is the only way to catch the
 * pooling/decay/exploration bugs that example tests pass straight over — and it
 * runs free in CI because every draw is seeded.
 */
describe("affinity — convergence simulation", () => {
  /** Deterministic PRNG, so a failure is reproducible from its seed. */
  const rng = (seed: number) => {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  /** Draw `n` outcomes for a candidate whose TRUE quality is `quality`. */
  const draw = (c: Candidate, quality: number, n: number, next: () => number) =>
    Array.from({ length: n }, () =>
      outcome({
        cli: c.cli,
        vendor: c.vendor,
        model: c.model,
        // Noisy around the truth, so the ranking has to actually average.
        score: (quality - 0.5) * 12 + (next() - 0.5) * 8
      })
    )

  it("finds the genuinely better model within a modest observation budget", () => {
    const trials = 200
    const wins = Array.from({ length: trials }, (_, seed) => {
      const next = rng(seed + 1)
      const outcomes = [...draw(SOL, 0.8, 20, next), ...draw(OPUS, 0.35, 20, next)]
      return rank(outcomes)[0]!.model === SOL.model ? 1 : 0
    }).reduce<number>((a, b) => a + b, 0)
    expect(wins / trials).toBeGreaterThan(0.9)
  })

  it("does not claim a winner between two equal models", () => {
    // Guards the opposite failure: a ranking that always looks decisive is not
    // measuring anything.
    const trials = 200
    const solFirst = Array.from({ length: trials }, (_, seed) => {
      const next = rng(seed + 1)
      const outcomes = [...draw(SOL, 0.55, 15, next), ...draw(OPUS, 0.55, 15, next)]
      return rank(outcomes)[0]!.model === SOL.model ? 1 : 0
    }).reduce<number>((a, b) => a + b, 0)
    expect(solFirst / trials).toBeGreaterThan(0.25)
    expect(solFirst / trials).toBeLessThan(0.75)
  })

  it("keeps sampling the runner-up, so a cell can never starve", () => {
    const next = rng(7)
    const outcomes = draw(SOL, 0.8, 30, next)
    const promoted = Array.from({ length: 200 }, () =>
      rank(outcomes, { random: next, explorationRate: 0.15 })[0]!.model
    )
    // The under-sampled candidate must come up sometimes — that is the whole
    // point of exploration — but must not dominate.
    const opusShare = promoted.filter((m) => m === OPUS.model).length / promoted.length
    expect(opusShare).toBeGreaterThan(0.05)
    expect(opusShare).toBeLessThan(0.35)
  })
})
