import type { Plan, PlanRound } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { PlanRoundStore } from "./plan-round-store.js"
import { withTempRoot } from "./test-support.js"

/**
 * The stored round is the audit trail behind a plan: it is what lets you answer
 * "did the critic really attack, and did the proposer engage or cave?" after the
 * fact. So the behaviour that matters: absent → null, a set round survives a
 * fresh read, a later round replaces the earlier one, the pre-revision proposal
 * is retained alongside the revision, and an undecodable file degrades to null
 * rather than making the Plan tab unopenable. Real temp filesystem.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const run = <A>(
  effect: Effect.Effect<A, never, PlanRoundStore | FileSystem.FileSystem | Path.Path | AppPaths>
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(PlanRoundStore.Default, temp.layer))))

const plan = (id: string): Plan => ({
  id,
  summary: "Add a tier column",
  steps: [],
  comments: [],
  status: "proposed",
  structured: true,
  raw: "# plan"
})

const round = (over: Partial<PlanRound> = {}): PlanRound => ({
  id: "r1",
  sessionId: "s1",
  createdAt: "2026-07-18T10:00:00.000Z",
  proposer: { cli: "claude", model: "claude-fable-5", vendor: "anthropic" },
  adversary: { cli: "codex", model: "gpt-5.6-sol", vendor: "openai" },
  proposal: plan("p1"),
  critique: {
    by: { cli: "codex", model: "gpt-5.6-sol", vendor: "openai" },
    challenges: [
      {
        id: "c1",
        severity: "major",
        title: "ordering",
        rationale: "the backfill precedes the column",
        status: "addressed",
        defence: null
      }
    ],
    targets: ["01"],
    note: null
  },
  revised: plan("p2"),
  outcome: "revised",
  ...over
})

describe("PlanRoundStore", () => {
  it("returns null for a session that was never planned", async () => {
    expect(await run(PlanRoundStore.get("nobody"))).toBeNull()
  })

  it("round-trips a full round", async () => {
    const r = round()
    await run(PlanRoundStore.set(r))
    expect(await run(PlanRoundStore.get("s1"))).toStrictEqual(r)
  })

  it("keeps the pre-revision proposal beside the revision", async () => {
    // Without both you cannot tell whether the proposer engaged with the
    // critique or simply capitulated to it — which is the whole point of
    // storing this at all.
    await run(PlanRoundStore.set(round()))
    const back = await run(PlanRoundStore.get("s1"))
    expect(back?.proposal.id).toBe("p1")
    expect(back?.revised?.id).toBe("p2")
    expect(back?.critique?.challenges[0]?.status).toBe("addressed")
  })

  it("replaces an earlier round for the same session", async () => {
    await run(PlanRoundStore.set(round()))
    await run(PlanRoundStore.set(round({ id: "r2", outcome: "clean", revised: null })))
    const back = await run(PlanRoundStore.get("s1"))
    expect(back?.id).toBe("r2")
    expect(back?.outcome).toBe("clean")
  })

  it("degrades an undecodable file to null rather than failing", async () => {
    // A round written by an older build must not make the Plan tab unopenable.
    const dir = join(temp.root, "plan-rounds")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "s1.json"), "{ not a round }")
    expect(await run(PlanRoundStore.get("s1"))).toBeNull()
  })

  it("does not throw when the state directory cannot be created", async () => {
    // Persistence is best-effort: a filesystem hiccup must never fail a round
    // the operator can already see on screen.
    mkdirSync(temp.root, { recursive: true })
    // A plain file where the directory should be: `makeDirectory` fails, and the
    // write that follows must fail quietly rather than propagating.
    writeFileSync(join(temp.root, "plan-rounds"), "not a directory")
    await expect(run(PlanRoundStore.set(round()))).resolves.toBeUndefined()
  })
})
