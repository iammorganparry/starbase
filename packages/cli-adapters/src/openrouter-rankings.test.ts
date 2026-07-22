import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RankingService,
  fetchOpenRouterRankings,
  parseOpenRouterRankings
} from "./openrouter-rankings.js"

const payload = JSON.stringify({
  data: {
    spend: {
      windowDays: 30,
      tasks: [
        {
          tag: "code:frontend_ui",
          spendShareOfTotal: 0.2,
          models: [
            { model: "anthropic/claude-sonnet-5-20260630", share: 0.7 },
            { model: "openai/gpt-5.5-20260423", share: 0.3 }
          ]
        },
        {
          tag: "code:general_impl",
          spendShareOfTotal: 0.1,
          models: [
            { model: "anthropic/claude-sonnet-5-20260630", share: 0.2 },
            { model: "openai/gpt-5.5-20260423", share: 0.8 }
          ]
        },
        {
          tag: "code:sql_database",
          spendShareOfTotal: 0.1,
          models: [
            { model: "anthropic/claude-sonnet-5-20260630", share: 0.1 },
            { model: "openai/gpt-5.5-20260423", share: 0.9 }
          ]
        },
        {
          tag: "agent:workflow_execution",
          spendShareOfTotal: 0.2,
          models: [
            { model: "anthropic/claude-sonnet-5-20260630", share: 0.6 },
            { model: "openai/gpt-5.5-20260423", share: 0.4 }
          ]
        }
      ]
    }
  }
})

afterEach(() => vi.unstubAllGlobals())

describe("parseOpenRouterRankings", () => {
  it("maps ranked task usage into deterministic Gigaplan task-kind scores", () => {
    const snapshot = parseOpenRouterRankings(payload, "2026-07-22T00:00:00.000Z")
    expect(snapshot).toMatchObject({
      source: "OpenRouter Rankings",
      windowDays: 30,
      fetchedAt: "2026-07-22T00:00:00.000Z"
    })
    const claude = snapshot.models.find((model) => model.model.startsWith("anthropic/"))
    const codex = snapshot.models.find((model) => model.model.startsWith("openai/"))
    expect(claude?.scores.frontend).toBeCloseTo(0.5333, 3)
    expect(codex?.scores.frontend).toBeCloseTo(0.4667, 3)
    expect(claude?.scores.backend).toBeCloseTo(0.375, 3)
    expect(codex?.scores.backend).toBeCloseTo(0.625, 3)
  })

  it("rejects a response without known routing tasks", () => {
    const empty = JSON.stringify({
      data: {
        spend: {
          windowDays: 30,
          tasks: [
            {
              tag: "unknown",
              spendShareOfTotal: 1,
              models: [{ model: "openai/gpt", share: 1 }]
            }
          ]
        }
      }
    })
    expect(() => parseOpenRouterRankings(empty, "2026-07-22T00:00:00.000Z")).toThrow(
      /no routable model data/
    )
  })
})

describe("fetchOpenRouterRankings", () => {
  it("reads the credential-free rankings endpoint", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(payload))
    const snapshot = await fetchOpenRouterRankings(
      fetcher,
      new Date("2026-07-22T00:00:00.000Z")
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/frontend/v1/rankings/task-spend"
    )
    expect(snapshot.models).toHaveLength(2)
  })
})

describe("RankingService", () => {
  it("caches a successful snapshot for the process", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(payload))
    vi.stubGlobal("fetch", fetcher)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* RankingService.latest
        const second = yield* RankingService.latest
        return { first, second }
      }).pipe(Effect.provide(RankingService.Default))
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(result.second).toBe(result.first)
  })

  it("returns no ranking instead of blocking planning when OpenRouter fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })))
    const result = await Effect.runPromise(
      RankingService.latest.pipe(Effect.provide(RankingService.Default))
    )
    expect(result).toBeNull()
  })

  it("does not make a network request in scripted test/e2e mode", async () => {
    const previous = process.env.STARBASE_SCRIPTED_AGENT
    process.env.STARBASE_SCRIPTED_AGENT = "1"
    const fetcher = vi.fn(async () => new Response(payload))
    vi.stubGlobal("fetch", fetcher)
    try {
      const result = await Effect.runPromise(
        RankingService.latest.pipe(Effect.provide(RankingService.Default))
      )
      expect(result).toBeNull()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.STARBASE_SCRIPTED_AGENT
      else process.env.STARBASE_SCRIPTED_AGENT = previous
    }
  })
})
