import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Plan, PlanStep, RouteCandidate } from "./conversation.js"
import { Plan as PlanSchema } from "./conversation.js"
import type { RoutingRankingSnapshot } from "./gigaplan-routing.js"
import {
  GIGAPLAN_ROUTING_POLICY_VERSION,
  canonicalRouteCandidates,
  routeQuotaState,
  resolvePlanRoutes
} from "./gigaplan-routing.js"
import type { ProviderModels } from "./models.js"
import type { Usage } from "./usage.js"

const catalog: ReadonlyArray<ProviderModels> = [
  {
    cli: "claude",
    label: "Claude Code",
    models: [
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" }
    ]
  },
  {
    cli: "codex",
    label: "Codex",
    models: [
      { id: "gpt-5.6-sol", label: "Sol" },
      { id: "gpt-5.5", label: "5.5" }
    ]
  }
]

const ranking: RoutingRankingSnapshot = {
  source: "OpenRouter Rankings",
  windowDays: 30,
  fetchedAt: "2026-07-22T00:00:00.000Z",
  models: [
    {
      model: "anthropic/claude-sonnet-5-20260630",
      scores: { backend: 0.1, frontend: 0.4 }
    },
    {
      model: "openai/gpt-5.5-20260423",
      scores: { backend: 0.6, frontend: 0.2 }
    }
  ]
}

const usage = (
  claude: "ok" | "nearing" | "limited" | "unknown",
  codex: "ok" | "nearing" | "limited" | "unknown"
): Usage => ({
  fetchedAt: "2026-07-22T00:00:00.000Z",
  providers: [
    {
      cli: "claude",
      name: "Claude",
      plan: "Max",
      available: true,
      windows: [{ label: "Weekly · all models", resetsAt: null, utilization: 50, status: claude }]
    },
    {
      cli: "codex",
      name: "Codex",
      plan: "Plus",
      available: true,
      windows: [{ label: "Weekly", resetsAt: null, utilization: 50, status: codex }]
    }
  ]
})

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  id: "s1",
  number: "01",
  title: "Change the backend",
  intent: "Implement the service",
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
  ...over
})

const plan = (item: PlanStep): Plan => ({
  id: "p1",
  summary: "Route it",
  steps: [item],
  comments: [],
  status: "proposed",
  structured: true,
  raw: "summary: Route it"
})

const selected = (input: Plan): RouteCandidate | undefined => {
  const decision = resolvePlanRoutes(input, { catalog, mode: "active" }).plan.steps[0]?.routing
    ?.decision
  return decision === undefined ? undefined : { cli: decision.cli, model: decision.model }
}

describe("canonicalRouteCandidates", () => {
  it("contains every live model exactly once in canonical order", () => {
    expect(canonicalRouteCandidates([...catalog].reverse())).toStrictEqual([
      { cli: "claude", model: "opus" },
      { cli: "claude", model: "sonnet" },
      { cli: "codex", model: "gpt-5.5" },
      { cli: "codex", model: "gpt-5.6-sol" }
    ])
  })
})

describe("resolvePlanRoutes", () => {
  it("attaches matching task affinity evidence to the planner assignee", () => {
    const result = resolvePlanRoutes(
      plan(
        step({
          taskKind: "schema",
          assignee: {
            cli: "codex",
            model: "gpt-5.6-sol",
            reason: "planner choice"
          }
        })
      ),
      {
        catalog,
        mode: "shadow",
        affinityEnabled: false,
        affinity: [
          {
            candidate: { cli: "codex", model: "gpt-5.6-sol" },
            taskKind: "backend",
            observations: 99,
            confidence: 0.99,
            score: 0.99
          },
          {
            candidate: { cli: "codex", model: "gpt-5.6-sol" },
            taskKind: "schema",
            observations: 19,
            confidence: 0.9,
            score: 0.8
          }
        ]
      }
    )

    expect(result.plan.steps[0]?.assignee).toStrictEqual({
      cli: "codex",
      model: "gpt-5.6-sol",
      reason: "planner choice",
      evidence: { level: "affinity", observations: 19 }
    })
  })

  it("uses an eligible workspace override before the planner preference", () => {
    const result = resolvePlanRoutes(
      plan(
        step({
          taskKind: "backend",
          assignee: {
            cli: "claude",
            model: "sonnet",
            reason: "planner choice"
          }
        })
      ),
      {
        catalog,
        mode: "active",
        overrides: [
          {
            taskKind: "backend",
            routes: [{ cli: "codex", model: "gpt-5.6-sol" }]
          }
        ]
      }
    )
    expect(result.unresolved).toStrictEqual([])
    expect(result.plan.steps[0]?.routing?.decision).toMatchObject({
      cli: "codex",
      model: "gpt-5.6-sol",
      provenance: "user-override"
    })
  })

  it("caps active fallback to two policy-ordered alternatives", () => {
    const wideCatalog: ReadonlyArray<ProviderModels> = [
      ...catalog,
      {
        cli: "opencode",
        label: "OpenCode",
        models: [{ id: "openrouter/moonshot/kimi", label: "Kimi" }]
      }
    ]
    const routing = resolvePlanRoutes(
      plan(step({ taskKind: "backend", effort: "deep", risk: "high" })),
      {
        catalog: wideCatalog,
        mode: "active",
        systemDefault: { cli: "codex", model: "gpt-5.6-sol" }
      }
    ).plan.steps[0]?.routing

    expect(routing?.decision).toMatchObject({ cli: "codex", model: "gpt-5.6-sol" })
    expect(routing?.decision.alternatives).toStrictEqual([
      { cli: "codex", model: "gpt-5.5" },
      { cli: "claude", model: "opus" }
    ])
  })

  it("records semantic policy while shadow mode preserves the live planner route", () => {
    const result = resolvePlanRoutes(
      plan(
        step({
          taskKind: "backend",
          assignee: { cli: "claude", model: "sonnet", reason: "legacy route" }
        })
      ),
      { catalog, mode: "shadow" }
    )
    const routing = result.plan.steps[0]?.routing
    expect(routing?.decision).toMatchObject({
      cli: "claude",
      model: "sonnet",
      provenance: "planner-preference"
    })
    expect(routing?.decision.alternatives).toStrictEqual([])
    expect(routing?.shadowDecision).toMatchObject({
      cli: "codex",
      provenance: "policy-profile"
    })
    expect(routing?.policyVersion).toBe(GIGAPLAN_ROUTING_POLICY_VERSION)
  })

  it("keeps planner preference ahead of runtime usage rankings in active mode", () => {
    const input = plan(
      step({
        taskKind: "backend",
        assignee: { cli: "claude", model: "sonnet", reason: "planner choice" }
      })
    )
    const active = resolvePlanRoutes(input, { catalog, mode: "active", ranking }).plan.steps[0]
      ?.routing
    expect(active?.decision).toMatchObject({
      cli: "claude",
      model: "sonnet",
      provenance: "planner-preference"
    })
    expect(active?.decision.alternatives[0]).toStrictEqual({ cli: "codex", model: "gpt-5.5" })

    const shadow = resolvePlanRoutes(input, { catalog, mode: "shadow", ranking }).plan.steps[0]
      ?.routing
    expect(shadow?.decision).toMatchObject({
      cli: "claude",
      model: "sonnet",
      provenance: "planner-preference"
    })
    expect(shadow?.shadowDecision).toMatchObject({
      cli: "codex",
      model: "gpt-5.5",
      provenance: "runtime-ranking"
    })
  })

  it("keeps explicit overrides ahead of runtime rankings", () => {
    const routed = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      catalog,
      mode: "active",
      ranking,
      overrides: [{ taskKind: "backend", routes: [{ cli: "claude", model: "sonnet" }] }]
    }).plan.steps[0]?.routing
    expect(routed?.decision).toMatchObject({
      cli: "claude",
      model: "sonnet",
      provenance: "user-override"
    })
  })

  it("rejects a route at its local limit even when runtime rankings prefer it", () => {
    const routed = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      catalog,
      mode: "active",
      ranking,
      usage: usage("ok", "limited")
    }).plan.steps[0]?.routing

    expect(routed?.decision).toMatchObject({ cli: "claude", model: "sonnet" })
    expect(routed?.rejected).toContainEqual({
      candidate: { cli: "codex", model: "gpt-5.5" },
      provenance: "runtime-ranking",
      reason: "local provider usage is at its limit"
    })
  })

  it("records each rejected candidate and reason once across source pools", () => {
    const rankedOpus: RoutingRankingSnapshot = {
      source: "OpenRouter Rankings",
      windowDays: 30,
      fetchedAt: "2026-07-22T00:00:00.000Z",
      models: [
        {
          model: "anthropic/claude-4.8-opus-20260528",
          scores: { frontend: 0.9 }
        }
      ]
    }
    const rejected = resolvePlanRoutes(plan(step({ taskKind: "frontend" })), {
      catalog,
      mode: "active",
      ranking: rankedOpus,
      usage: usage("limited", "ok")
    }).plan.steps[0]?.routing?.rejected

    const facts = rejected?.map(
      (item) => `${item.candidate.cli}:${item.candidate.model}:${item.reason}`
    )
    expect(new Set(facts).size).toBe(facts?.length)
    expect(rejected?.filter((item) => item.candidate.model === "opus")).toStrictEqual([
      {
        candidate: { cli: "claude", model: "opus" },
        provenance: "runtime-ranking",
        reason: "local provider usage is at its limit"
      }
    ])
  })

  it("demotes a nearing automatic route behind one with known headroom", () => {
    const routed = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      catalog,
      mode: "active",
      ranking,
      usage: usage("ok", "nearing")
    }).plan.steps[0]?.routing

    expect(routed?.decision).toMatchObject({ cli: "claude", model: "sonnet" })
    expect(routed?.decision.alternatives).toContainEqual({ cli: "codex", model: "gpt-5.5" })
  })

  it("keeps an explicit workspace override unless its limit is reached", () => {
    const context = {
      catalog,
      mode: "active" as const,
      usage: usage("ok", "nearing"),
      overrides: [
        { taskKind: "backend" as const, routes: [{ cli: "codex" as const, model: "gpt-5.5" }] }
      ]
    }
    expect(
      resolvePlanRoutes(plan(step({ taskKind: "backend" })), context).plan.steps[0]?.routing
        ?.decision
    ).toMatchObject({ cli: "codex", provenance: "user-override" })

    const limited = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      ...context,
      usage: usage("ok", "limited")
    }).plan.steps[0]?.routing
    expect(limited?.decision.cli).toBe("claude")
    expect(limited?.rejected).toContainEqual({
      candidate: { cli: "codex", model: "gpt-5.5" },
      provenance: "user-override",
      reason: "local provider usage is at its limit"
    })
  })

  it("applies a model-scoped quota only to the named model", () => {
    const scoped: Usage = {
      fetchedAt: "2026-07-22T00:00:00.000Z",
      providers: [
        {
          cli: "claude",
          name: "Claude",
          plan: "Max",
          available: true,
          windows: [
            { label: "Weekly · Opus", resetsAt: null, utilization: 100, status: "limited" }
          ]
        }
      ]
    }
    const routed = resolvePlanRoutes(plan(step({ taskKind: "frontend" })), {
      catalog,
      mode: "active",
      usage: scoped
    }).plan.steps[0]?.routing

    expect(routed?.decision).toMatchObject({ cli: "claude", model: "sonnet" })
    expect(routed?.rejected.some((item) => item.candidate.model === "opus")).toBe(true)
  })

  it("reports the reset for the applicable model-scoped quota", () => {
    const scoped: Usage = {
      fetchedAt: "2026-07-22T00:00:00.000Z",
      providers: [
        {
          cli: "claude",
          name: "Claude",
          plan: "Max",
          available: true,
          windows: [
            {
              label: "Weekly · Opus",
              resetsAt: "2026-07-23T00:00:00.000Z",
              utilization: 100,
              status: "limited"
            },
            {
              label: "Weekly · Sonnet",
              resetsAt: "2026-07-24T00:00:00.000Z",
              utilization: 100,
              status: "limited"
            }
          ]
        }
      ]
    }

    expect(routeQuotaState({ cli: "claude", model: "opus" }, scoped)).toStrictEqual({
      status: "limited",
      resetsAt: "2026-07-23T00:00:00.000Z"
    })
    expect(routeQuotaState({ cli: "claude", model: "sonnet" }, scoped)).toStrictEqual({
      status: "limited",
      resetsAt: "2026-07-24T00:00:00.000Z"
    })
  })

  it("fails open when local usage cannot be read", () => {
    const unavailable: Usage = {
      fetchedAt: "2026-07-22T00:00:00.000Z",
      providers: [
        { cli: "codex", name: "Codex", plan: null, available: false, windows: [] }
      ]
    }
    const routed = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      catalog,
      mode: "active",
      ranking,
      usage: unavailable
    }).plan.steps[0]?.routing
    expect(routed?.decision).toMatchObject({ cli: "codex", model: "gpt-5.5" })
  })

  it("does not transfer a variant ranking to the base model", () => {
    const variantOnly: RoutingRankingSnapshot = {
      source: "OpenRouter Rankings",
      windowDays: 30,
      fetchedAt: "2026-07-22T00:00:00.000Z",
      models: [
        {
          model: "openai/gpt-5.5-mini-20260423",
          scores: { backend: 0.99 }
        }
      ]
    }
    const routed = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      catalog,
      mode: "active",
      ranking: variantOnly
    }).plan.steps[0]?.routing

    expect(routed?.decision).toMatchObject({
      cli: "codex",
      model: "gpt-5.5",
      provenance: "policy-profile"
    })
  })

  it("matches dated OpenRouter permaslugs to live CLI ids and Claude aliases", () => {
    const current: RoutingRankingSnapshot = {
      source: "OpenRouter Rankings",
      windowDays: 30,
      fetchedAt: "2026-07-22T00:00:00.000Z",
      models: [
        {
          model: "openai/gpt-5.6-sol-20260709",
          scores: { backend: 0.7, frontend: 0.2 }
        },
        {
          model: "anthropic/claude-4.8-opus-20260528",
          scores: { backend: 0.2, frontend: 0.8 }
        }
      ]
    }
    const backend = resolvePlanRoutes(plan(step({ taskKind: "backend" })), {
      catalog,
      mode: "active",
      ranking: current
    }).plan.steps[0]?.routing
    const frontend = resolvePlanRoutes(plan(step({ taskKind: "frontend" })), {
      catalog,
      mode: "active",
      ranking: current
    }).plan.steps[0]?.routing
    expect(backend?.decision).toMatchObject({ cli: "codex", model: "gpt-5.6-sol" })
    expect(frontend?.decision).toMatchObject({ cli: "claude", model: "opus" })
  })

  it("rejects stale preferences and returns only live alternatives", () => {
    const result = resolvePlanRoutes(
      plan(
        step({
          taskKind: "schema",
          assignee: { cli: "codex", model: "retired", reason: "old plan" }
        })
      ),
      { catalog, mode: "active" }
    )
    const routing = result.plan.steps[0]?.routing
    expect(routing?.rejected).toContainEqual({
      candidate: { cli: "codex", model: "retired" },
      provenance: "planner-preference",
      reason: "not in the live model catalogue"
    })
    const live = new Set(
      canonicalRouteCandidates(catalog).map((candidate) => `${candidate.cli}:${candidate.model}`)
    )
    expect(
      [routing?.decision, ...(routing?.decision.alternatives ?? [])].every(
        (candidate) => candidate !== undefined && live.has(`${candidate.cli}:${candidate.model}`)
      )
    ).toBe(true)
  })

  it("defaults missing route inputs without changing branch steps", () => {
    const branch = step({ kind: "branch", condition: "enabled?" })
    const result = resolvePlanRoutes(plan(branch), { catalog })
    expect(result.plan.steps[0]).toStrictEqual(branch)

    const normal = resolvePlanRoutes(plan(step()), { catalog }).plan.steps[0]
    expect(normal).toMatchObject({
      taskKind: "backend",
      effort: "standard",
      risk: "medium"
    })
  })

  it("reports a typed unresolved step when no model is live", () => {
    const result = resolvePlanRoutes(plan(step()), { catalog: [] })
    expect(result.unresolved).toStrictEqual([
      {
        stepId: "s1",
        stepNumber: "01",
        reason: "no live model can run this step",
        rejected: []
      }
    ])
  })

  it("keeps persisted route metadata backward compatible", () => {
    const legacy = plan(step())
    expect(Either.isRight(Schema.decodeUnknownEither(PlanSchema)(legacy))).toBe(true)
    const routed = resolvePlanRoutes(legacy, { catalog }).plan
    expect(Schema.decodeUnknownSync(PlanSchema)(routed)).toStrictEqual(routed)
  })

  it("routes frontend and backend through independently authored profiles", () => {
    expect(selected(plan(step({ taskKind: "frontend" })))?.cli).toBe("claude")
    expect(selected(plan(step({ taskKind: "backend" })))?.cli).toBe("codex")
  })
})
