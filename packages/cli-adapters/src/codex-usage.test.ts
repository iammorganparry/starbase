import { describe, expect, it } from "vitest"
import type { CodexRateLimitsResponse } from "./codex-usage.js"
import { fetchCodexUsage, toCodexProviderUsage } from "./codex-usage.js"

const REAL: CodexRateLimitsResponse = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    planType: "pro",
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_700_000_000 },
    secondary: { usedPercent: 85, windowDurationMins: 10_080, resetsAt: 1_700_100_000 }
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      planType: "pro",
      primary: { usedPercent: 97, windowDurationMins: 10_080, resetsAt: null },
      secondary: null
    },
    codex: {
      limitId: "codex",
      limitName: null,
      planType: "pro",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 85, windowDurationMins: 10_080, resetsAt: 1_700_100_000 }
    }
  }
}

describe("toCodexProviderUsage", () => {
  it("maps account rate-limit buckets into labelled, status-banded windows", () => {
    expect(toCodexProviderUsage(REAL)).toStrictEqual({
      cli: "codex",
      name: "Codex",
      plan: "Pro",
      available: true,
      windows: [
        {
          label: "Current session",
          resetsAt: "2023-11-14T22:13:20.000Z",
          utilization: 10,
          status: "ok"
        },
        {
          label: "Weekly · all models",
          resetsAt: "2023-11-16T02:00:00.000Z",
          utilization: 85,
          status: "nearing"
        },
        {
          label: "Weekly · GPT-5.3-Codex-Spark",
          resetsAt: null,
          utilization: 97,
          status: "limited"
        }
      ]
    })
  })

  it("falls back to the legacy single bucket and marks an empty response unavailable", () => {
    const legacy = toCodexProviderUsage({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
        secondary: null
      },
      rateLimitsByLimitId: null
    })
    expect(legacy.plan).toBe("Plus")
    expect(legacy.windows.map((w) => w.label)).toStrictEqual(["Weekly · all models"])

    expect(
      toCodexProviderUsage({
        rateLimits: { planType: null, primary: null, secondary: null },
        rateLimitsByLimitId: null
      })
    ).toStrictEqual({ cli: "codex", name: "Codex", plan: null, available: false, windows: [] })
  })
})

describe("fetchCodexUsage", () => {
  it("resolves null when the binary does not exist", async () => {
    await expect(fetchCodexUsage("/nonexistent/codex-does-not-exist")).resolves.toBeNull()
  })

  it.skipIf(!process.env.STARBASE_LIVE_CODEX)(
    "reads real rate limits from the logged-in Codex app server",
    async () => {
      const response = await fetchCodexUsage(null)
      if (response === null) throw new Error("Codex returned no rate-limit snapshot")
      expect(toCodexProviderUsage(response).windows.length).toBeGreaterThan(0)
    },
    10_000
  )
})
