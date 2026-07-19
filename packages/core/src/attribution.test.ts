import { describe, expect, it } from "vitest"
import type { PlanStep } from "./conversation.js"
import { attributePath, normalizePath, rollUpConfidence, samePath } from "./attribution.js"

const step = (number: string, ...paths: ReadonlyArray<string>): PlanStep =>
  ({
    id: `s_${number}`,
    number,
    title: `Step ${number}`,
    intent: "",
    approach: [],
    kind: "step",
    condition: null,
    parentId: null,
    dependsOn: [],
    blocks: [],
    files: paths.map((path) => ({ path, change: "M" as const, added: 1, removed: 0 })),
    guards: [],
    code: null,
    diff: null,
    status: "proposed",
    flagged: false
  }) as PlanStep

describe("samePath", () => {
  it("matches an absolute worktree path against a repo-relative one", () => {
    expect(samePath("/w/src/auth.ts", "src/auth.ts")).toBe(true)
  })

  it("only matches anchored at a separator", () => {
    // The bug this prevents: an unanchored endsWith makes "a.ts" match
    // "src/schema.ts" and attributes an outcome to an unrelated step.
    expect(samePath("/w/src/schema.ts", "a.ts")).toBe(false)
    expect(samePath("/w/src/my-auth.ts", "auth.ts")).toBe(false)
  })

  it("is reflexive and symmetric", () => {
    expect(samePath("src/a.ts", "src/a.ts")).toBe(true)
    expect(samePath("/w/src/a.ts", "src/a.ts")).toBe(samePath("src/a.ts", "/w/src/a.ts"))
  })
})

describe("normalizePath", () => {
  it("gives Windows and POSIX one shape to compare", () => {
    expect(normalizePath("src\\auth.ts")).toBe("src/auth.ts")
  })
})

describe("attributePath", () => {
  const steps = [step("01", "src/schema.ts"), step("02", "src/api.ts"), step("03", "src/api.ts")]

  it("is exact when one step owns the file", () => {
    const a = attributePath(steps, "/w/src/schema.ts")
    expect(a?.step.number).toBe("01")
    expect(a?.confidence).toBe("exact")
  })

  it("is AMBIGUOUS when two steps claim the file, rather than guessing", () => {
    // A confidently wrong attribution poisons a cell far more than a missing
    // one, because the cell has no way to tell it was wrong.
    const a = attributePath(steps, "/w/src/api.ts")
    expect(a?.confidence).toBe("ambiguous")
  })

  it("returns null when no step claims it", () => {
    // Work outside the plan is real, but attributing it to whichever step
    // happens to be nearby would be fabrication.
    expect(attributePath(steps, "/w/src/unrelated.ts")).toBeNull()
  })

  it("handles Windows separators on either side", () => {
    expect(attributePath([step("01", "src\\schema.ts")], "/w/src/schema.ts")?.step.number).toBe("01")
  })

  it("returns null for a plan with no declared files", () => {
    expect(attributePath([step("01")], "/w/src/a.ts")).toBeNull()
  })
})

describe("rollUpConfidence", () => {
  const exact = { step: step("01"), confidence: "exact" as const }
  const ambiguous = { step: step("02"), confidence: "ambiguous" as const }

  it("is exact only when every attribution is", () => {
    expect(rollUpConfidence([exact, exact])).toBe("exact")
  })

  it("is pessimistic: one ambiguity taints the whole outcome", () => {
    // An outcome is a single score against a single model, so one misattributed
    // file is enough to make the number wrong.
    expect(rollUpConfidence([exact, ambiguous, exact])).toBe("ambiguous")
  })

  it("treats an empty set as exact", () => {
    expect(rollUpConfidence([])).toBe("exact")
  })
})
