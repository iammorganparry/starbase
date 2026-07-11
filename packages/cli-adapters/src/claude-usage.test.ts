import { describe, expect, it } from "vitest"
import type { SdkUsageResponse } from "./claude-usage.js"
import { fetchClaudeUsage, toClaudeProviderUsage } from "./claude-usage.js"

/**
 * The mapper is pure and always tested against a captured real response. The
 * live read spawns the SDK and needs the user's `claude` login, so it's gated
 * behind STARBASE_LIVE_CLAUDE=1 (run locally: `STARBASE_LIVE_CLAUDE=1 pnpm
 * --filter @starbase/cli-adapters test claude-usage`).
 */

// A real response captured from `usage_EXPERIMENTAL...` on a Max plan.
const REAL: SdkUsageResponse = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 10, resets_at: "2026-07-11T21:40:00.462423+00:00" },
    seven_day: { utilization: 12, resets_at: "2026-07-18T02:00:00.462445+00:00" },
    seven_day_opus: null
  }
}

describe("toClaudeProviderUsage", () => {
  it("maps live windows, capitalizes the plan, and derives status from utilization", () => {
    const p = toClaudeProviderUsage(REAL)
    expect(p).toStrictEqual({
      cli: "claude",
      name: "Claude",
      plan: "Max",
      available: true,
      windows: [
        {
          label: "Current session",
          resetsAt: "2026-07-11T21:40:00.462423+00:00",
          utilization: 10,
          status: "ok"
        },
        {
          label: "Weekly · all models",
          resetsAt: "2026-07-18T02:00:00.462445+00:00",
          utilization: 12,
          status: "ok"
        }
      ]
    })
  })

  it("includes the Opus window only when the plan reports it, and bands status", () => {
    const p = toClaudeProviderUsage({
      ...REAL,
      rate_limits: {
        five_hour: { utilization: 85, resets_at: null }, // nearing
        seven_day: { utilization: 97, resets_at: null }, // limited
        seven_day_opus: { utilization: null, resets_at: null } // unknown
      }
    })
    expect(p.windows.map((w) => [w.label, w.status])).toStrictEqual([
      ["Current session", "nearing"],
      ["Weekly · all models", "limited"],
      ["Weekly · Opus", "unknown"]
    ])
  })

  it("marks the provider unavailable for API-key / non-plan sessions", () => {
    const p = toClaudeProviderUsage({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null
    })
    expect(p.available).toBe(false)
    expect(p.plan).toBeNull()
    expect(p.windows).toStrictEqual([])
  })
})

describe("fetchClaudeUsage (live)", () => {
  it.skipIf(!process.env.STARBASE_LIVE_CLAUDE)(
    "reads real plan usage from the logged-in SDK",
    async () => {
      const res = await fetchClaudeUsage(null)
      expect(typeof res.rate_limits_available).toBe("boolean")
      // A claude.ai subscriber (Pro/Max/Team) reports plan windows with numbers.
      if (res.rate_limits_available) {
        const p = toClaudeProviderUsage(res)
        expect(p.available).toBe(true)
        expect(p.windows.length).toBeGreaterThan(0)
        expect(p.windows.some((w) => typeof w.utilization === "number")).toBe(true)
        expect(p.windows.some((w) => w.resetsAt !== null)).toBe(true)
      }
    },
    30_000
  )
})
