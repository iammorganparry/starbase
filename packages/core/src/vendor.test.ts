import { describe, expect, it } from "vitest"
import type { ProviderModels } from "./models.js"
import { planningReadiness, reachableVendors, vendorOf } from "./vendor.js"

const provider = (
  cli: ProviderModels["cli"],
  ...ids: ReadonlyArray<string>
): ProviderModels => ({
  cli,
  label: cli,
  models: ids.map((id) => ({ id, label: id }))
})

describe("vendorOf", () => {
  it("treats claude and codex as their own lab, whatever the model id", () => {
    // The harness IS the vendor for these — an alias like "opus" resolves
    // server-side and tells us nothing, but it can only ever be Anthropic.
    expect(vendorOf("claude", "opus")).toBe("anthropic")
    expect(vendorOf("claude", "claude-fable-5")).toBe("anthropic")
    expect(vendorOf("codex", "gpt-5.6-sol")).toBe("openai")
    expect(vendorOf("claude", null)).toBe("anthropic")
  })

  it("never lets cursor participate", () => {
    // No real adapter — cursor falls through to the scripted stub, so a cursor
    // "critic" would return fabricated output.
    expect(vendorOf("cursor", "sonnet-4.5")).toBeNull()
  })

  it("resolves a gateway one segment deeper to the lab that made the weights", () => {
    expect(vendorOf("opencode", "openrouter/anthropic/claude-opus-4.5")).toBe("anthropic")
    expect(vendorOf("opencode", "openrouter/moonshot/kimi-k3")).toBe("moonshot")
  })

  it("uses the provider directly when it is not a gateway", () => {
    expect(vendorOf("opencode", "anthropic/claude-opus-4.5")).toBe("anthropic")
    expect(vendorOf("opencode", "openai/gpt-5.6")).toBe("openai")
  })

  it("falls back to the gateway itself when it resells nothing", () => {
    // opencode Zen's own free tier is not a resold model — `big-pickle` is a
    // model name, not a lab. Only a further-qualified remainder names a vendor,
    // or every gateway-native model would invent a vendor after itself and
    // "diversify" a panel against nothing.
    expect(vendorOf("opencode", "opencode/big-pickle")).toBe("opencode")
    expect(vendorOf("opencode", "opencode/north-mini-code-free")).toBe("opencode")
    expect(vendorOf("opencode", "openrouter/gpt-4")).toBe("openrouter")
  })

  it("does not treat two of a gateway's own models as two labs", () => {
    // The regression this guards: a lone opencode install with only Zen's free
    // tier would otherwise look like a fully diverse panel.
    const zen = ["opencode/big-pickle", "opencode/hy3-free", "opencode/mimo-v2.5-free"]
    expect(new Set(zen.map((id) => vendorOf("opencode", id)))).toEqual(new Set(["opencode"]))
  })

  it("fails OPEN — an unknown provider counts as its own vendor", () => {
    // Over-counting offers a slightly weaker pairing; under-counting hides the
    // feature with no clue why.
    expect(vendorOf("opencode", "somenewlab/model-1")).toBe("somenewlab")
  })

  it("is total over junk input", () => {
    expect(vendorOf("opencode", "")).toBeNull()
    expect(vendorOf("opencode", null)).toBeNull()
    expect(vendorOf("opencode", "/")).toBeNull()
    expect(vendorOf("opencode", "bare")).toBe("bare")
  })

  it("collapses the same weights reached two different ways", () => {
    // The case that makes CLI-counting wrong: two harnesses, one lab.
    expect(vendorOf("claude", "opus")).toBe(
      vendorOf("opencode", "openrouter/anthropic/claude-opus-4.5")
    )
  })
})

describe("reachableVendors", () => {
  it("prefers the native harness so a subscription is used ahead of a metered key", () => {
    const reach = reachableVendors([
      provider("claude", "opus"),
      provider("opencode", "openrouter/anthropic/claude-opus-4.5", "openrouter/openai/gpt-5.6")
    ])
    const anthropic = reach.find((v) => v.vendor === "anthropic")
    expect(anthropic?.cli).toBe("claude")
    // OpenAI has no native harness installed here, so opencode carries it.
    expect(reach.find((v) => v.vendor === "openai")?.cli).toBe("opencode")
  })

  it("prefers codex for OpenAI when it is installed", () => {
    const reach = reachableVendors([
      provider("codex", "gpt-5.6-sol"),
      provider("opencode", "openrouter/openai/gpt-5.6")
    ])
    expect(reach.find((v) => v.vendor === "openai")?.cli).toBe("codex")
  })

  it("uses opencode for labs with no native harness", () => {
    const reach = reachableVendors([provider("opencode", "openrouter/moonshot/kimi-k3")])
    expect(reach).toEqual([
      { vendor: "moonshot", cli: "opencode", models: [{ id: "openrouter/moonshot/kimi-k3", label: "openrouter/moonshot/kimi-k3" }] }
    ])
  })

  it("carries only the preferred harness's models for that vendor", () => {
    const reach = reachableVendors([
      provider("claude", "opus", "sonnet"),
      provider("opencode", "openrouter/anthropic/claude-opus-4.5")
    ])
    expect(reach.find((v) => v.vendor === "anthropic")?.models.map((m) => m.id)).toEqual([
      "opus",
      "sonnet"
    ])
  })

  it("drops cursor entirely", () => {
    const reach = reachableVendors([provider("cursor", "sonnet-4.5", "gpt-5")])
    expect(reach).toEqual([])
  })

  it("is stable in order, so role assignment is reproducible", () => {
    const catalog = [provider("opencode", "openrouter/moonshot/kimi-k3"), provider("claude", "opus")]
    expect(reachableVendors(catalog).map((v) => v.vendor)).toEqual(["anthropic", "moonshot"])
  })
})

describe("planningReadiness", () => {
  it("is ready with two distinct labs", () => {
    const r = planningReadiness([provider("claude", "opus"), provider("codex", "gpt-5.6-sol")])
    expect(r.ready).toBe(true)
    expect(r.reason).toBeNull()
    expect(r.vendors.map((v) => v.vendor)).toEqual(["anthropic", "openai"])
  })

  it("is READY from a single harness with a diverse key", () => {
    // One CLI, two labs — counting installed CLIs would have hidden this.
    const r = planningReadiness([
      provider("opencode", "openrouter/anthropic/claude-opus-4.5", "openrouter/moonshot/kimi-k3")
    ])
    expect(r.ready).toBe(true)
    expect(r.vendors.map((v) => v.vendor)).toEqual(["anthropic", "moonshot"])
  })

  it("is NOT ready when two harnesses reach only one lab", () => {
    // The other case CLI-counting gets wrong: a model arguing with itself.
    const r = planningReadiness([
      provider("claude", "opus"),
      provider("opencode", "openrouter/anthropic/claude-opus-4.5")
    ])
    expect(r.ready).toBe(false)
    expect(r.reason).toMatch(/second model provider/)
    expect(r.reason).toMatch(/anthropic/)
  })

  it("names the fix rather than going quiet", () => {
    const none = planningReadiness([])
    expect(none.ready).toBe(false)
    expect(none.reason).toMatch(/install Claude Code, Codex or opencode/)

    const one = planningReadiness([provider("claude", "opus")])
    expect(one.reason).toMatch(/Settings · Providers/)
  })

  it("does not count cursor toward readiness", () => {
    const r = planningReadiness([provider("claude", "opus"), provider("cursor", "gpt-5")])
    expect(r.ready).toBe(false)
  })
})

describe("harness preference cannot change gating", () => {
  it("leaves the vendor set identical however many harnesses reach it", () => {
    // Preference decides HOW we reach a lab, never how many labs exist — so it
    // can never flip the feature on or off.
    const oneWay = planningReadiness([provider("claude", "opus"), provider("codex", "gpt-5.6-sol")])
    const twoWays = planningReadiness([
      provider("claude", "opus"),
      provider("codex", "gpt-5.6-sol"),
      provider("opencode", "openrouter/anthropic/claude-opus-4.5", "openrouter/openai/gpt-5.6")
    ])
    expect(twoWays.vendors.map((v) => v.vendor)).toEqual(oneWay.vendors.map((v) => v.vendor))
    expect(twoWays.ready).toBe(oneWay.ready)
  })
})
