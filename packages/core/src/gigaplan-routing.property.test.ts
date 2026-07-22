import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Plan, PlanStep } from "./conversation.js"
import { canonicalRouteCandidates, resolvePlanRoutes } from "./gigaplan-routing.js"
import type { ProviderModels } from "./models.js"

const step: PlanStep = {
  id: "s1",
  number: "01",
  title: "Work",
  intent: "Work",
  approach: [],
  kind: "step",
  condition: null,
  parentId: null,
  dependsOn: [],
  blocks: [],
  files: [],
  guards: [],
  code: null,
  diff: null,
  status: "proposed",
  flagged: false,
  taskKind: "backend"
}

const plan: Plan = {
  id: "p1",
  summary: "Work",
  steps: [step],
  comments: [],
  status: "proposed",
  structured: true,
  raw: "summary: Work"
}

const provider = (cli: "claude" | "codex", models: ReadonlyArray<string>): ProviderModels => ({
  cli,
  label: cli,
  models: models.map((id) => ({ id, label: id }))
})

describe("Gigaplan routing properties", () => {
  it("is stable across provider and model insertion order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/), {
          minLength: 1,
          maxLength: 8
        }),
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/), {
          minLength: 1,
          maxLength: 8
        }),
        (claudeModels, codexModels) => {
          const left = [provider("claude", claudeModels), provider("codex", codexModels)]
          const right = [
            provider("codex", [...codexModels].reverse()),
            provider("claude", [...claudeModels].reverse())
          ]
          expect(canonicalRouteCandidates(left)).toStrictEqual(canonicalRouteCandidates(right))
          expect(resolvePlanRoutes(plan, { catalog: left, mode: "active" })).toStrictEqual(
            resolvePlanRoutes(plan, { catalog: right, mode: "active" })
          )
        }
      ),
      { numRuns: 60 }
    )
  })

  it("never selects a candidate outside the supplied catalogue", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/), {
          minLength: 1,
          maxLength: 8
        }),
        (models) => {
          const catalog = [provider("codex", models)]
          const result = resolvePlanRoutes(plan, { catalog, mode: "active" })
          const decision = result.plan.steps[0]?.routing?.decision
          expect(decision).toBeDefined()
          expect(canonicalRouteCandidates(catalog)).toContainEqual({
            cli: decision?.cli,
            model: decision?.model
          })
        }
      ),
      { numRuns: 60 }
    )
  })
})
