import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Usage, UsageWindow } from "./usage.js"

/**
 * The usage snapshot crosses the RPC boundary (main → renderer → modal). What
 * matters: the nested schema round-trips (including nullable reset/utilization),
 * and a malformed window is rejected rather than silently coerced.
 */

describe("Usage", () => {
  it("round-trips a full snapshot through encode → decode", () => {
    const usage: Usage = {
      fetchedAt: "2026-07-11T10:00:00.000Z",
      providers: [
        {
          cli: "claude",
          name: "Claude",
          plan: "Max",
          available: true,
          windows: [
            { label: "Current session", resetsAt: "2026-07-11T15:00:00.000Z", utilization: 42, status: "ok" },
            { label: "Weekly · Opus", resetsAt: null, utilization: null, status: "unknown" }
          ]
        },
        { cli: "codex", name: "Codex", plan: null, available: false, windows: [] }
      ]
    }
    expect(Schema.decodeUnknownSync(Usage)(Schema.encodeSync(Usage)(usage))).toStrictEqual(usage)
  })

  it("rejects a window with a non-literal status", () => {
    const bad = { label: "x", resetsAt: null, utilization: null, status: "maxed" }
    expect(Either.isLeft(Schema.decodeUnknownEither(UsageWindow)(bad))).toBe(true)
  })
})
