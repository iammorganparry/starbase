import type { CliInfo } from "@starbase/core"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { UsageService } from "./usage.js"
import { clearUsage, readClaudeUsage, recordClaudeRateLimit } from "./usage-store.js"

/**
 * Two seams here: the process-global store that captures Claude's rate-limit
 * events, and the service that assembles them (plus the "not available yet"
 * placeholder for other harnesses) into the modal's `Usage` snapshot.
 */

const cli = (kind: CliInfo["kind"], available: boolean): CliInfo => ({
  kind,
  label: kind,
  binPath: available ? `/usr/bin/${kind}` : null,
  version: null,
  available
})

const run = <A>(effect: Effect.Effect<A, never, UsageService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageService.Default)))

afterEach(() => clearUsage())

describe("usage-store", () => {
  it("records a rate-limit window keyed by type, converting reset seconds → ISO", () => {
    recordClaudeRateLimit({ rateLimitType: "five_hour", status: "allowed", utilization: 30, resetsAt: 1_800_000_000 })
    const { windows, fetchedAt } = readClaudeUsage()
    const w = windows.get("five_hour")
    expect(w?.utilization).toBe(30)
    expect(w?.status).toBe("ok")
    expect(w?.resetsAt).toBe(new Date(1_800_000_000 * 1000).toISOString())
    expect(fetchedAt).not.toBeNull()
  })

  it("maps SDK statuses onto our UsageStatus and nulls a missing utilization", () => {
    recordClaudeRateLimit({ rateLimitType: "seven_day", status: "rejected" })
    recordClaudeRateLimit({ rateLimitType: "seven_day_opus", status: "allowed_warning" })
    const { windows } = readClaudeUsage()
    expect(windows.get("seven_day")?.status).toBe("limited")
    expect(windows.get("seven_day")?.utilization).toBeNull()
    expect(windows.get("seven_day_opus")?.status).toBe("nearing")
  })

  it("ignores an event with no rateLimitType", () => {
    recordClaudeRateLimit({ status: "rejected" })
    expect(readClaudeUsage().windows.size).toBe(0)
  })
})

describe("UsageService", () => {
  it("assembles Claude windows from the store and marks others unavailable", async () => {
    recordClaudeRateLimit({ rateLimitType: "five_hour", status: "allowed", utilization: 12, resetsAt: 1_800_000_000 })
    const usage = await run(UsageService.get([cli("claude", true), cli("codex", true)]))

    const claude = usage.providers.find((p) => p.cli === "claude")!
    expect(claude.available).toBe(true)
    expect(claude.windows.map((w) => w.label)).toStrictEqual([
      "Current session",
      "Weekly · all models",
      "Weekly · Opus"
    ])
    expect(claude.windows[0]!.utilization).toBe(12)
    // Windows never captured stay unknown rather than fabricating a value.
    expect(claude.windows[1]!.status).toBe("unknown")

    const codex = usage.providers.find((p) => p.cli === "codex")!
    expect(codex.available).toBe(false)
    expect(codex.windows).toStrictEqual([])
  })

  it("omits harnesses that aren't installed", async () => {
    const usage = await run(UsageService.get([cli("claude", true), cli("cursor", false)]))
    expect(usage.providers.map((p) => p.cli)).toStrictEqual(["claude"])
  })
})
