import { existsSync, readFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import type { Plan } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scriptedPlan } from "./adapter.js"
import { AppPaths } from "./app-paths.js"
import { PlanStore, planFileName } from "./plan-store.js"
import { withTempRoot } from "./test-support.js"

/**
 * The plan library is what makes a plan pickup-able in a later turn/session, so
 * the behaviours that matter are: a plan lands at a stable, worktree-scoped path;
 * its markdown round-trips; a revision overwrites in place; distinct plans and
 * distinct worktrees never collide; and listing reflects what was written. Real
 * temp filesystem, real round-trips.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const run = <A>(
  effect: Effect.Effect<A, never, PlanStore | FileSystem.FileSystem | Path.Path | AppPaths>
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(PlanStore.Default, temp.layer))))

/** A plan with an overridable summary/raw/id, built off the shared fixture. */
const planWith = (over: Partial<Plan>): Plan => ({ ...scriptedPlan("s1", 1), ...over })

const WT = "/tmp/starbase/worktrees/starbase/terminal"

describe("planFileName", () => {
  it("kebab-cases and strips unsafe characters", () => {
    expect(planFileName("Refactor Auth Flow!")).toBe("refactor-auth-flow")
    expect(planFileName("  Add rate-limiting (v2)  ")).toBe("add-rate-limiting-v2")
  })

  it("falls back to 'plan' for an empty/symbol-only name and caps length", () => {
    expect(planFileName("")).toBe("plan")
    expect(planFileName("***")).toBe("plan")
    expect(planFileName("x".repeat(200))).toHaveLength(60)
  })
})

describe("PlanStore", () => {
  it("writes the plan markdown under <plansDir>/<worktree-basename>/<slug>.md", async () => {
    const plan = planWith({ summary: "Refactor auth flow", raw: "# Refactor auth flow\n\nDo the thing." })
    const file = await run(PlanStore.write(WT, plan))

    expect(basename(file)).toBe("refactor-auth-flow.md")
    // Namespaced by the worktree's basename, not its full path.
    expect(basename(dirname(file))).toBe("terminal")
    expect(dirname(dirname(file)).endsWith("/.starbase")).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf8")).toBe("# Refactor auth flow\n\nDo the thing.")
  })

  it("overwrites the same file when a plan with the same summary is revised (latest wins)", async () => {
    const v1 = planWith({ id: "plan_s1_1", summary: "Ship feature", raw: "v1 body" })
    const v2 = planWith({ id: "plan_s1_2", summary: "Ship feature", raw: "v2 body" })
    const { first, second, files } = await run(
      Effect.gen(function* () {
        const first = yield* PlanStore.write(WT, v1)
        const second = yield* PlanStore.write(WT, v2)
        const files = yield* PlanStore.list(WT)
        return { first, second, files }
      })
    )
    expect(second).toBe(first) // same path — a revision overwrites
    expect(readFileSync(first, "utf8")).toBe("v2 body")
    expect(files).toStrictEqual([first]) // exactly one plan file, not two
  })

  it("keeps distinct plans (different summaries) in their own files", async () => {
    const files = await run(
      Effect.gen(function* () {
        yield* PlanStore.write(WT, planWith({ summary: "Plan A", raw: "a" }))
        yield* PlanStore.write(WT, planWith({ summary: "Plan B", raw: "b" }))
        return yield* PlanStore.list(WT)
      })
    )
    expect(files).toHaveLength(2)
    expect(files.map((f) => basename(f))).toStrictEqual(["plan-a.md", "plan-b.md"]) // sorted
  })

  it("namespaces plans by worktree so different sessions never collide", async () => {
    const other = "/tmp/starbase/worktrees/starbase/other"
    const { here, there } = await run(
      Effect.gen(function* () {
        yield* PlanStore.write(WT, planWith({ summary: "Mine", raw: "mine" }))
        yield* PlanStore.write(other, planWith({ summary: "Theirs", raw: "theirs" }))
        const here = yield* PlanStore.list(WT)
        const there = yield* PlanStore.list(other)
        return { here, there }
      })
    )
    expect(here.map((f) => basename(f))).toStrictEqual(["mine.md"])
    expect(there.map((f) => basename(f))).toStrictEqual(["theirs.md"])
  })

  it("lists nothing for a worktree that has no saved plans", async () => {
    const files = await run(PlanStore.list("/tmp/starbase/worktrees/starbase/never-planned"))
    expect(files).toStrictEqual([])
  })

  it("falls back to a summary heading when the plan has no raw body", async () => {
    const file = await run(PlanStore.write(WT, planWith({ summary: "Bare plan", raw: "" })))
    expect(readFileSync(file, "utf8")).toBe("# Bare plan\n")
  })
})
