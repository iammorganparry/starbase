import { describe, expect, it } from "vitest"
import type { Plan, PlanStep, RouteEffort, RouteRisk } from "./conversation.js"
import {
  canonicalRouteCandidates,
  resolvePlanRoutes,
  summarizeRouteAttempts
} from "./gigaplan-routing.js"
import type { ProviderModels } from "./models.js"
import { TASK_KINDS } from "./task-kind.js"

const catalog: ReadonlyArray<ProviderModels> = [
  {
    cli: "claude",
    label: "Claude",
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" }
    ]
  },
  {
    cli: "codex",
    label: "Codex",
    models: [
      { id: "gpt-5.6-sol", label: "Sol" },
      { id: "gpt-5.5", label: "5.5" }
    ]
  },
  {
    cli: "opencode",
    label: "OpenCode",
    models: [{ id: "openrouter/moonshot/kimi", label: "Kimi" }]
  }
]

const step = (effort: RouteEffort, risk: RouteRisk): PlanStep => ({
  id: "s1",
  number: "01",
  title: "Scenario",
  intent: "Evaluate routing",
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
  effort,
  risk
})

const plan = (item: PlanStep): Plan => ({
  id: "evaluation",
  summary: "Evaluation",
  steps: [item],
  comments: [],
  status: "proposed",
  structured: true,
  raw: "summary: Evaluation"
})

describe("Gigaplan routing release fixtures", () => {
  it("selects a live deterministic route across every semantic profile", () => {
    const live = new Set(
      canonicalRouteCandidates(catalog).map((candidate) => `${candidate.cli}/${candidate.model}`)
    )
    const efforts: ReadonlyArray<RouteEffort> = ["quick", "standard", "deep"]
    const risks: ReadonlyArray<RouteRisk> = ["low", "medium", "high"]

    for (const taskKind of TASK_KINDS) {
      for (const effort of efforts) {
        for (const risk of risks) {
          const input = plan({ ...step(effort, risk), taskKind })
          const first = resolvePlanRoutes(input, {
            catalog,
            mode: "active",
            systemDefault: { cli: "claude", model: "opus" }
          })
          const second = resolvePlanRoutes(input, {
            catalog: [...catalog].reverse(),
            mode: "active",
            systemDefault: { cli: "claude", model: "opus" }
          })
          expect(first).toStrictEqual(second)
          const decision = first.plan.steps[0]?.routing?.decision
          expect(first.unresolved).toStrictEqual([])
          expect(live.has(`${decision?.cli}/${decision?.model}`)).toBe(true)
        }
      }
    }
  })

  it("derives rollout counters locally from persisted attempts", () => {
    const routed = resolvePlanRoutes(plan(step("standard", "medium")), {
      catalog,
      mode: "active"
    }).plan
    const item = routed.steps[0]!
    const decision = item.routing!.decision
    const withAttempts: Plan = {
      ...routed,
      steps: [
        {
          ...item,
          routing: {
            ...item.routing!,
            attempts: [
              {
                attempt: 1,
                candidate: { cli: decision.cli, model: decision.model },
                outcome: "failed",
                reason: "provider overloaded",
                mutationPossible: false,
                createdAt: "2026-07-22T00:00:00.000Z"
              },
              {
                attempt: 2,
                candidate: decision.alternatives[0]!,
                outcome: "done",
                reason: null,
                mutationPossible: true,
                createdAt: "2026-07-22T00:01:00.000Z"
              }
            ]
          }
        }
      ]
    }
    expect(summarizeRouteAttempts(withAttempts)).toStrictEqual({
      routedSteps: 1,
      attempts: 2,
      divergences: 1,
      blocked: 0,
      failed: 1,
      completed: 1
    })
  })
})
