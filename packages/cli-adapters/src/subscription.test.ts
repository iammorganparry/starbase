import { describe, expect, it } from "vitest"
import { billingPath, harnessEnv, METERED_ENV_KEYS } from "./subscription.js"

const ENV = { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" }

describe("harnessEnv", () => {
  it("withholds the metered key when the harness has a plan", () => {
    // The whole point: Starbase drives what you already pay for, and an
    // exported key silently overrides that with per-token billing.
    const out = harnessEnv("codex", ENV, true)
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.PATH).toBe("/usr/bin")
  })

  it("leaves a key alone when there is no plan to fall back on", () => {
    // An operator with only an API key must keep working. Enforcing a
    // preference they cannot satisfy would be worse than the problem.
    expect(harnessEnv("codex", ENV, false).OPENAI_API_KEY).toBe("sk-x")
  })

  it("only withholds the key belonging to THAT harness", () => {
    // Claude's plan says nothing about how Codex should be billed.
    const out = harnessEnv("claude", ENV, true)
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.OPENAI_API_KEY).toBe("sk-x")
  })

  it("never touches opencode, whose whole model is bring-your-own-key", () => {
    // Stripping here would disable the providers opencode exists to reach.
    expect(METERED_ENV_KEYS.opencode).toBeUndefined()
    expect(harnessEnv("opencode", ENV, true)).toStrictEqual(ENV)
  })

  it("returns a complete environment, because the SDKs replace rather than merge", () => {
    // A partial env would strand the child without PATH or HOME.
    const out = harnessEnv("codex", ENV, true)
    expect(Object.keys(out).sort()).toStrictEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"])
  })

  it("drops undefined values rather than passing them through", () => {
    expect(harnessEnv("claude", { A: undefined, B: "b" }, false)).toStrictEqual({ B: "b" })
  })
})

describe("billingPath", () => {
  it("reports what a run will actually be charged to", () => {
    // Surfaced even when nothing is changed: the silent case is the one that
    // cost money.
    expect(billingPath("codex", ENV, true)).toBe("subscription")
    expect(billingPath("codex", ENV, false)).toBe("api-key")
    expect(billingPath("codex", { PATH: "/usr/bin" }, false)).toBe("unknown")
  })

  it("does not call an empty key a key", () => {
    expect(billingPath("codex", { OPENAI_API_KEY: "" }, false)).toBe("unknown")
  })
})
