import type { Plan, PlanStep } from "./conversation.js"
import { describe, expect, it } from "vitest"
import { executionOrder, resolveRunner } from "./plan-execution.js"

const step = (over: Partial<PlanStep> & { id: string; number: string }): PlanStep => ({
  title: `Step ${over.number}`,
  intent: "",
  approach: [],
  kind: "step",
  condition: null,
  parentId: null,
  dependsOn: [],
  blocks: [],
  files: [],
  guards: [],
  ...over
} as PlanStep)

const planOf = (steps: ReadonlyArray<PlanStep>): Plan =>
  ({ id: "p1", summary: "", structured: true, graph: null, steps }) as Plan

const numbers = (steps: ReadonlyArray<PlanStep>) => steps.map((s) => s.number)

describe("executionOrder", () => {
  it("runs a plain plan exactly top to bottom", () => {
    // The reviewed artifact and the run must not diverge for no reason — the
    // operator approved an order they could see.
    const plan = planOf([
      step({ id: "a", number: "01" }),
      step({ id: "b", number: "02" }),
      step({ id: "c", number: "03" })
    ])
    expect(numbers(executionOrder(plan).order)).toStrictEqual(["01", "02", "03"])
  })

  it("reorders to honour a dependency written out of sequence", () => {
    // The ordering defect the adversary exists to catch: a backfill listed
    // before the migration it needs.
    const plan = planOf([
      step({ id: "backfill", number: "01", dependsOn: ["02"] }),
      step({ id: "migrate", number: "02" })
    ])
    expect(numbers(executionOrder(plan).order)).toStrictEqual(["02", "01"])
  })

  it("resolves a dependency by id as well as by number", () => {
    const plan = planOf([
      step({ id: "backfill", number: "01", dependsOn: ["migrate"] }),
      step({ id: "migrate", number: "02" })
    ])
    expect(numbers(executionOrder(plan).order)).toStrictEqual(["02", "01"])
  })

  it("never runs a branch or its arms", () => {
    // Executing every arm of a conditional is not a conservative approximation
    // of executing the right one; it is actively wrong.
    const plan = planOf([
      step({ id: "a", number: "01" }),
      step({ id: "b", number: "02", kind: "branch", condition: "token expired?" }),
      step({ id: "c", number: "2a", kind: "branch-arm", parentId: "b" })
    ])
    const out = executionOrder(plan)
    expect(numbers(out.order)).toStrictEqual(["01"])
    expect(out.skipped.map((s) => [s.step.number, s.why])).toStrictEqual([
      ["02", "branch"],
      ["2a", "branch"]
    ])
  })

  it("refuses a cycle instead of hanging or guessing", () => {
    // A model can and does emit these. The loop must terminate, and the steps
    // must be reported rather than run in a made-up order.
    const plan = planOf([
      step({ id: "a", number: "01", dependsOn: ["02"] }),
      step({ id: "b", number: "02", dependsOn: ["01"] })
    ])
    const out = executionOrder(plan)
    expect(out.order).toHaveLength(0)
    expect(out.skipped.map((s) => s.why)).toStrictEqual(["unreachable", "unreachable"])
  })

  it("treats a self-dependency as the cycle it is", () => {
    const plan = planOf([step({ id: "a", number: "01", dependsOn: ["01"] })])
    const out = executionOrder(plan)
    expect(out.order).toHaveLength(0)
    expect(out.skipped[0]?.why).toBe("unreachable")
  })

  it("does not run a step that depends on something which does not exist", () => {
    // Running it anyway would violate the single ordering constraint its author
    // bothered to write down.
    const plan = planOf([
      step({ id: "a", number: "01", dependsOn: ["99"] }),
      step({ id: "b", number: "02" })
    ])
    const out = executionOrder(plan)
    expect(numbers(out.order)).toStrictEqual(["02"])
    expect(out.skipped.map((s) => [s.step.number, s.why])).toStrictEqual([["01", "unreachable"]])
  })

  it("does not run work queued behind an unreachable step", () => {
    // The subtle one: 03 is individually fine, but it was told to wait for 01,
    // and 01 is never going to happen.
    const plan = planOf([
      step({ id: "a", number: "01", dependsOn: ["nope"] }),
      step({ id: "c", number: "03", dependsOn: ["01"] })
    ])
    const out = executionOrder(plan)
    expect(out.order).toHaveLength(0)
    expect(out.skipped).toHaveLength(2)
  })

  it("accounts for every step, always", () => {
    // Nothing may be silently dropped: run it or say why not.
    const plan = planOf([
      step({ id: "a", number: "01" }),
      step({ id: "b", number: "02", kind: "branch" }),
      step({ id: "c", number: "03", dependsOn: ["03"] })
    ])
    const out = executionOrder(plan)
    expect(out.order.length + out.skipped.length).toBe(plan.steps.length)
  })
})

describe("resolveRunner", () => {
  const available = [
    { cli: "claude" as const, model: "opus" },
    { cli: "codex" as const, model: "gpt-5.6-sol" }
  ]

  it("uses the harness the plan assigned", () => {
    const s = step({
      id: "a",
      number: "01",
      assignee: { cli: "codex", model: "gpt-5.6-sol", reason: "schema work" }
    })
    expect(resolveRunner(s, available, null)).toStrictEqual({ cli: "codex", model: "gpt-5.6-sol" })
  })

  it("keeps the assigned harness even when its model id is unknown here", () => {
    // The lab is the substantive half of the choice; a stale model id is a far
    // smaller divergence than running on a different vendor entirely.
    const s = step({
      id: "a",
      number: "01",
      assignee: { cli: "codex", model: "gpt-6-unreleased", reason: "r" }
    })
    expect(resolveRunner(s, available, null)?.cli).toBe("codex")
  })

  it("falls back when the assigned harness is not installed here", () => {
    // A plan reviewed on one machine can be run on another; an assignee cannot
    // conjure an install.
    const s = step({
      id: "a",
      number: "01",
      assignee: { cli: "opencode", model: "x", reason: "r" }
    })
    expect(resolveRunner(s, available, { cli: "claude", model: "opus" })).toStrictEqual({
      cli: "claude",
      model: "opus"
    })
  })

  it("never routes a step back into the orchestrator", () => {
    // That would re-enter planning to execute one step of the plan it just made.
    const s = step({
      id: "a",
      number: "01",
      assignee: { cli: "starbase", model: "auto", reason: "r" }
    })
    expect(resolveRunner(s, available, null)?.cli).not.toBe("starbase")
    expect(resolveRunner(s, [{ cli: "starbase", model: "auto" }], null)).toBeNull()
    expect(resolveRunner(s, available, { cli: "starbase", model: "auto" })?.cli).toBe("claude")
  })

  it("reports that nothing can run it rather than guessing", () => {
    expect(resolveRunner(step({ id: "a", number: "01" }), [], null)).toBeNull()
  })
})
