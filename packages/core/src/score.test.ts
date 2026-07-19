import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { OutcomeSignals } from "./outcome.js"
import { AMBIGUOUS_WEIGHT, normaliseScore, scoreOutcome } from "./score.js"

const signals = (over: Partial<OutcomeSignals> = {}): OutcomeSignals => ({
  findingsCritical: 0,
  findingsMajor: 0,
  findingsMinor: 0,
  findingsNit: 0,
  ciPassed: null,
  merged: null,
  filesReverted: 0,
  planRevisions: 0,
  ...over
})

/** Generated signals, for the invariants example tests pass straight over. */
const arbSignals = (): fc.Arbitrary<OutcomeSignals> =>
  fc.record({
    findingsCritical: fc.nat({ max: 5 }),
    findingsMajor: fc.nat({ max: 8 }),
    findingsMinor: fc.nat({ max: 12 }),
    findingsNit: fc.nat({ max: 20 }),
    ciPassed: fc.constantFrom(true, false, null),
    merged: fc.constantFrom(true, false, null),
    filesReverted: fc.nat({ max: 6 }),
    planRevisions: fc.nat({ max: 5 })
  })

describe("scoreOutcome — table", () => {
  it("scores a clean merged change well", () => {
    expect(scoreOutcome(signals({ ciPassed: true, merged: true }))).toBeGreaterThan(0)
  })

  it("scores a closed change with critical findings badly", () => {
    expect(
      scoreOutcome(signals({ findingsCritical: 2, ciPassed: false, merged: false }))
    ).toBeLessThan(0)
  })

  it("charges nothing for nits", () => {
    // A nit is the reviewer being thorough, not the work being bad. Charging for
    // it would teach the loop to prefer models that say less.
    expect(scoreOutcome(signals({ findingsNit: 12 }))).toBe(scoreOutcome(signals()))
  })

  it("treats 'no CI ran' as neither pass nor fail", () => {
    // An unbuilt PR is not a broken one.
    expect(scoreOutcome(signals({ ciPassed: null }))).toBe(0)
    expect(scoreOutcome(signals({ ciPassed: false }))).toBeLessThan(0)
  })

  it("treats 'still open' as neither merged nor rejected", () => {
    expect(scoreOutcome(signals({ merged: null }))).toBe(0)
    expect(scoreOutcome(signals({ merged: false }))).toBeLessThan(0)
  })

  it("weighs a revert near a major finding", () => {
    // A revert is the most direct rejection there is — someone read the change
    // and undid it.
    expect(scoreOutcome(signals({ filesReverted: 1 }))).toBeLessThan(
      scoreOutcome(signals({ findingsMinor: 1 }))
    )
  })

  it("charges plan revisions only lightly", () => {
    // Sending a plan back is the system working. Penalising it heavily biases
    // the loop toward models that produce plans nobody bothers to argue with.
    expect(scoreOutcome(signals({ planRevisions: 3 }))).toBeGreaterThan(
      scoreOutcome(signals({ findingsMajor: 1 }))
    )
  })
})

describe("scoreOutcome — invariants", () => {
  it("is monotonic: adding a finding never improves a score", () => {
    // A scorer improvable by finding MORE problems would invert the whole loop.
    fc.assert(
      fc.property(
        arbSignals(),
        fc.constantFrom(
          "findingsCritical",
          "findingsMajor",
          "findingsMinor",
          "findingsNit"
        ) as fc.Arbitrary<keyof OutcomeSignals>,
        (s, key) => {
          const worse = { ...s, [key]: (s[key] as number) + 1 }
          expect(scoreOutcome(worse)).toBeLessThanOrEqual(scoreOutcome(s))
        }
      )
    )
  })

  it("is monotonic: upgrading a finding's severity never improves a score", () => {
    fc.assert(
      fc.property(arbSignals(), (s) => {
        const escalated = {
          ...s,
          findingsMinor: s.findingsMinor - 1 < 0 ? 0 : s.findingsMinor - 1,
          findingsMajor: s.findingsMajor + (s.findingsMinor > 0 ? 1 : 0)
        }
        if (s.findingsMinor === 0) return
        expect(scoreOutcome(escalated)).toBeLessThanOrEqual(scoreOutcome(s))
      })
    )
  })

  it("never scores a merged outcome below the same outcome closed", () => {
    fc.assert(
      fc.property(arbSignals(), (s) => {
        expect(scoreOutcome({ ...s, merged: true })).toBeGreaterThanOrEqual(
          scoreOutcome({ ...s, merged: false })
        )
      })
    )
  })

  it("never scores a passing build below the same outcome failing", () => {
    fc.assert(
      fc.property(arbSignals(), (s) => {
        expect(scoreOutcome({ ...s, ciPassed: true })).toBeGreaterThanOrEqual(
          scoreOutcome({ ...s, ciPassed: false })
        )
      })
    )
  })

  it("never improves with more reverts", () => {
    fc.assert(
      fc.property(arbSignals(), (s) => {
        expect(scoreOutcome({ ...s, filesReverted: s.filesReverted + 1 })).toBeLessThanOrEqual(
          scoreOutcome(s)
        )
      })
    )
  })

  it("is finite for every input", () => {
    fc.assert(
      fc.property(arbSignals(), (s) => {
        expect(Number.isFinite(scoreOutcome(s))).toBe(true)
      })
    )
  })
})

describe("normaliseScore", () => {
  it("bounds to (0, 1) so one catastrophe cannot own a cell forever", () => {
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), (raw) => {
        const n = normaliseScore(raw)
        expect(n).toBeGreaterThan(0)
        expect(n).toBeLessThan(1)
      })
    )
  })

  it("is non-decreasing, so normalising can never REORDER two outcomes", () => {
    // Non-strict on purpose: at the tails the curve saturates and two distinct
    // raw scores can map to the same normalised value. Losing resolution there
    // is fine; inverting the order would not be.
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          expect(normaliseScore(lo)).toBeLessThanOrEqual(normaliseScore(hi))
        }
      )
    )
  })

  it("keeps meaningfully different scores apart", () => {
    // The saturation allowance above must not be an excuse for a flat curve.
    expect(normaliseScore(3)).toBeGreaterThan(normaliseScore(0))
    expect(normaliseScore(0)).toBeGreaterThan(normaliseScore(-3))
  })
})

describe("AMBIGUOUS_WEIGHT", () => {
  it("counts an ambiguous attribution for less, but not nothing", () => {
    // Dropping them loses real signal; trusting them fully poisons cells.
    expect(AMBIGUOUS_WEIGHT).toBeGreaterThan(0)
    expect(AMBIGUOUS_WEIGHT).toBeLessThan(1)
  })
})
