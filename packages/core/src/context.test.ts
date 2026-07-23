import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./domain.js"
import { FALLBACK_MODELS, defaultModel } from "./models.js"
import {
  BUDGET_RANGE,
  ContextSnapshot,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_DIGEST_MODEL,
  MAX_SWAP_DEFERRALS,
  clampBudget,
  contextPhase,
  contextWindowFor,
  digestModelFor,
  reconcileWindow,
  shouldHoldSwap,
  triggerAt
} from "./context.js"

/**
 * The whole feature turns on one pure decision. These tests pin the property
 * that motivated it: compaction must fire on the QUALITY BUDGET, not on a
 * percentage of a window that may be 1M wide.
 */

describe("contextWindowFor", () => {
  it("reads a 1M window for current Claude Code aliases", () => {
    expect(contextWindowFor("claude", "claude-fable-5")).toBe(1_000_000)
    expect(contextWindowFor("claude", "opus")).toBe(1_000_000)
    expect(contextWindowFor("claude", "sonnet")).toBe(1_000_000)
    expect(contextWindowFor("claude", "haiku")).toBe(1_000_000)
  })

  // Harness model ids are unstable — `sonnet`, `claude-sonnet-4-5` and
  // `claude-sonnet-4-5-20250929` are all one model. Prefix matching is what
  // keeps the table from going stale every time a provider stamps a date on.
  it("matches a dated, fully-qualified model id", () => {
    expect(contextWindowFor("claude", "claude-sonnet-4-5-20250929")).toBe(1_000_000)
    expect(contextWindowFor("codex", "gpt-5.6-sol")).toBe(272_000)
  })

  // `claude-fable-5` contains no shorter model name today, but a future id like
  // `claude-fable-sonnet` would match both. Longest prefix has to win, or a 1M
  // model gets treated as 200k and compacts five times more than it needs to.
  it("prefers the longest matching prefix", () => {
    expect(contextWindowFor("claude", "claude-fable-5-preview")).toBe(1_000_000)
  })

  /**
   * Opus from 4.5 on carries a 1M window. Reading it as 200k is NOT the harmless
   * under-estimate the rest of this table relies on: it puts `triggerAt` at 170k,
   * so a session the harness runs happily at 500k sits permanently on "compacting
   * soon" and reseeds itself every turn. Observed in the wild at 213.6k.
   */
  it("reads a 1M window for modern Opus", () => {
    expect(contextWindowFor("claude", "claude-opus-4-5")).toBe(1_000_000)
    expect(contextWindowFor("claude", "claude-opus-4-8")).toBe(1_000_000)
    expect(contextWindowFor("claude", "claude-opus-4-5-20251101")).toBe(1_000_000)
  })

  // Known legacy Opus ids stay conservative even though the current `opus`
  // alias now resolves to a 1M-window model.
  it("keeps explicit legacy Opus ids at 200k", () => {
    expect(contextWindowFor("claude", "claude-opus-4-1")).toBe(200_000)
    expect(contextWindowFor("claude", "claude-opus-4-20250514")).toBe(200_000)
  })

  it("falls back to the harness floor for an unrecognised model", () => {
    expect(contextWindowFor("claude", "some-new-tier")).toBe(200_000)
    expect(contextWindowFor("codex", "gpt-6-unreleased")).toBe(272_000)
  })

  // Unknown is load-bearing, not a gap: cursor has no headless adapter, and
  // opencode resolves models from the user's own credentials across ~167
  // providers, so there is no honest default to invent.
  it("reports unknown for harnesses whose window we cannot know", () => {
    expect(contextWindowFor("cursor", "auto")).toBeNull()
    expect(contextWindowFor("opencode", "opencode/big-pickle")).toBeNull()
    expect(contextWindowFor("claude", null)).toBe(200_000)
  })

  it("lets a user override win — the only route to auto-compaction on opencode", () => {
    expect(contextWindowFor("opencode", "openrouter/anthropic/claude-opus-4.5", 200_000)).toBe(200_000)
    expect(contextWindowFor("claude", "sonnet", 1_000_000)).toBe(1_000_000)
  })

  it("ignores a nonsensical override rather than trusting it", () => {
    expect(contextWindowFor("claude", "sonnet", 0)).toBe(1_000_000)
    expect(contextWindowFor("claude", "sonnet", -5)).toBe(1_000_000)
    expect(contextWindowFor("claude", "sonnet", null)).toBe(1_000_000)
  })
})

describe("clampBudget", () => {
  it("holds the budget inside the usable band", () => {
    expect(clampBudget(1_000)).toBe(BUDGET_RANGE.min)
    expect(clampBudget(9_000_000)).toBe(BUDGET_RANGE.max)
    expect(clampBudget(300_000)).toBe(300_000)
  })
})

describe("triggerAt", () => {
  // The headline property. 85% of 1M is 850k — deep into the rot the feature
  // exists to avoid. The budget has to win.
  it("triggers a 1M-window model at the budget, not at 850k", () => {
    expect(triggerAt(1_000_000, DEFAULT_BUDGET_TOKENS)).toBe(500_000)
  })

  // The mirror property. A 200k model can't reach a 500k budget, so the safety
  // margin has to win or it would never compact at all and simply hard-fail.
  it("triggers a 200k-window model at its safety margin, not at the budget", () => {
    expect(triggerAt(200_000, DEFAULT_BUDGET_TOKENS)).toBe(170_000)
  })

  it("triggers a 272k Codex window at its safety margin", () => {
    expect(triggerAt(272_000, DEFAULT_BUDGET_TOKENS)).toBe(231_200)
  })

  it("keeps a 256k window below its safety margin", () => {
    expect(triggerAt(256_000, DEFAULT_BUDGET_TOKENS)).toBe(217_600)
  })

  it("clamps an out-of-band budget before comparing", () => {
    expect(triggerAt(1_000_000, 10_000_000)).toBe(BUDGET_RANGE.max)
    expect(triggerAt(1_000_000, 1_000)).toBe(BUDGET_RANGE.min)
  })
})

/**
 * The table is a guess keyed on an unstable model id, and a guess can be
 * DISPROVEN by what the session has actually been observed holding.
 */
describe("reconcileWindow", () => {
  it("raises a window the session has already exceeded", () => {
    // A real session held 598k while the table insisted on 200k. Uncorrected,
    // `triggerAt` sat at 170k and the session compacted on every single turn.
    expect(reconcileWindow(200_000, 598_000)).toBe(598_000)
  })

  it("leaves a window the readings agree with", () => {
    expect(reconcileWindow(1_000_000, 213_600)).toBe(1_000_000)
  })

  // A low reading proves nothing about the ceiling, so this only ever raises.
  it("never lowers a window on a small reading", () => {
    expect(reconcileWindow(1_000_000, 10)).toBe(1_000_000)
    expect(reconcileWindow(200_000, 0)).toBe(200_000)
  })

  // Unknown stays unknown: a harness we cannot measure must not have a ceiling
  // invented for it from one reading, or it starts compacting against a number
  // nobody vouched for.
  it("refuses to invent a window for an unmeasurable harness", () => {
    expect(reconcileWindow(null, 598_000)).toBeNull()
    expect(reconcileWindow(0, 598_000)).toBeNull()
  })

  it("ignores a garbage reading", () => {
    expect(reconcileWindow(200_000, Number.NaN)).toBe(200_000)
    expect(reconcileWindow(200_000, -5)).toBe(200_000)
  })
})

describe("contextPhase", () => {
  const base = { window: 1_000_000, budget: DEFAULT_BUDGET_TOKENS, auto: true, digestReady: false }

  it("stays idle comfortably inside the band", () => {
    expect(contextPhase({ ...base, tokens: 120_000 })).toBe("idle")
  })

  it("prepares once the working set crosses the budget", () => {
    expect(contextPhase({ ...base, tokens: 510_000 })).toBe("prepare")
  })

  it("swaps once a digest is ready and we are still over", () => {
    expect(contextPhase({ ...base, tokens: 510_000, digestReady: true })).toBe("swap")
  })

  // 510k is only 51% of a 1M window. A percentage rule would call this idle and
  // let the session rot for another 340k tokens. This is the bug being designed
  // away, so it gets its own test.
  it("acts at 51% of a 1M window because the band, not the window, is the limit", () => {
    expect(contextPhase({ ...base, tokens: 510_000 })).toBe("prepare")
    expect(510_000 / 1_000_000).toBeLessThan(0.55)
  })

  it("never escalates past unknown when auto-compaction is off", () => {
    expect(contextPhase({ ...base, tokens: 900_000, auto: false })).toBe("unknown")
    expect(contextPhase({ ...base, tokens: 900_000, auto: false, digestReady: true })).toBe("unknown")
  })

  // A session we cannot measure is a session we leave alone — the harness's own
  // limit stays the backstop, exactly as it behaves today.
  it("never escalates past unknown without a window", () => {
    expect(contextPhase({ ...base, tokens: 900_000, window: null })).toBe("unknown")
    expect(contextPhase({ ...base, tokens: 900_000, window: 0 })).toBe("unknown")
  })

  it("treats a garbage reading as unknown rather than acting on it", () => {
    expect(contextPhase({ ...base, tokens: Number.NaN })).toBe("unknown")
    expect(contextPhase({ ...base, tokens: -1 })).toBe("unknown")
  })
})

/**
 * `contextPhase` says whether there is enough context to be worth compacting.
 * This says whether compacting RIGHT NOW would cost more than it saves.
 *
 * The asymmetry it encodes: a wrong "hold" costs one turn of extra context and
 * is bounded twice over (the ceiling and the deferral cap). A wrong "swap" costs
 * the session the working state it was in the middle of using.
 */
describe("shouldHoldSwap", () => {
  const base = {
    midFlow: false,
    localHold: false,
    tokens: 120_000,
    window: 200_000,
    deferrals: 0
  }

  it("never holds a session with no signal at all", () => {
    expect(shouldHoldSwap(base)).toBe(false)
  })

  it("holds a mid-flow session that still has room", () => {
    expect(shouldHoldSwap({ ...base, midFlow: true })).toBe(true)
  })

  // The digest's verdict and the structural signals are independent evidence:
  // a summary cannot see an unanswered question, and a question does not tell
  // you a debugging thread is live.
  it("holds on a structural signal even when the summary saw nothing", () => {
    expect(shouldHoldSwap({ ...base, localHold: true })).toBe(true)
  })

  // Deferral is a QUALITY preference; the ceiling is physics. Past the safety
  // line the alternative to compacting is a hard context error mid-turn.
  it("yields to the ceiling even when the session is mid-flow", () => {
    expect(shouldHoldSwap({ ...base, midFlow: true, localHold: true, tokens: 190_000 })).toBe(false)
    expect(shouldHoldSwap({ ...base, midFlow: true, tokens: 199_000 })).toBe(false)
  })

  /**
   * The band the gate actually operates in. On a 200k model `triggerAt` is
   * 170k, so a digest only ever exists above that — a hold ceiling at the same
   * 0.85 would make every hold impossible and the feature dead code.
   */
  it("holds inside the band between the trigger and the ceiling", () => {
    expect(shouldHoldSwap({ ...base, midFlow: true, tokens: 171_000 })).toBe(true)
    expect(shouldHoldSwap({ ...base, midFlow: true, tokens: 189_000 })).toBe(true)
  })

  // Without the cap, a session in a long unbroken flow would defer forever and
  // sit deep in the rot band — the exact failure compaction exists to prevent.
  it("stops holding once the deferral cap is reached", () => {
    expect(shouldHoldSwap({ ...base, midFlow: true, deferrals: MAX_SWAP_DEFERRALS - 1 })).toBe(true)
    expect(shouldHoldSwap({ ...base, midFlow: true, deferrals: MAX_SWAP_DEFERRALS })).toBe(false)
    expect(shouldHoldSwap({ ...base, midFlow: true, deferrals: 99 })).toBe(false)
  })

  // An unmeasurable session has no ceiling to yield to, so the cap is the only
  // bound — it must still be honoured rather than deferring forever.
  it("holds without a window but still respects the cap", () => {
    expect(shouldHoldSwap({ ...base, midFlow: true, window: null })).toBe(true)
    expect(shouldHoldSwap({ ...base, midFlow: true, window: null, deferrals: 3 })).toBe(false)
  })

  it("treats garbage inputs as a reason to compact, never to hold", () => {
    expect(shouldHoldSwap({ ...base, midFlow: true, deferrals: Number.NaN })).toBe(false)
    expect(shouldHoldSwap({ ...base, midFlow: true, tokens: Number.NaN })).toBe(true)
    expect(shouldHoldSwap({ ...base, midFlow: true, window: 0 })).toBe(true)
  })
})

describe("DEFAULT_DIGEST_MODEL / digestModelFor", () => {
  // The digest is mechanical summarisation, so it reaches for the CHEAPEST tier
  // — the exact inverse of the reviewer, which reaches for a stronger model than
  // wrote the code. Both run on the user's own subscription.
  it("summarises on a cheaper tier than the session writes code with", () => {
    expect(DEFAULT_DIGEST_MODEL.claude).toBe("haiku")
    expect(DEFAULT_DIGEST_MODEL.claude).not.toBe(defaultModel("claude"))
  })

  // Same guard the reviewer has: a digest model the harness won't accept fails
  // at runtime, silently, in a background fiber nobody is watching.
  it("names a digest model the harness actually offers", () => {
    for (const cli of ["claude", "codex", "cursor", "opencode"] as const) {
      expect(FALLBACK_MODELS[cli].map((m) => m.id)).toContain(DEFAULT_DIGEST_MODEL[cli])
    }
  })

  it("honours the user's backgroundModel override", () => {
    expect(digestModelFor("claude", "claude-haiku-4-5")).toBe("claude-haiku-4-5")
  })

  it("falls back when the override is empty", () => {
    expect(digestModelFor("claude", "")).toBe("haiku")
    expect(digestModelFor("claude", undefined)).toBe("haiku")
  })
})

describe("wire types", () => {
  it("round-trips a snapshot through encode → decode", () => {
    const snapshot: ContextSnapshot = {
      sessionId: "s1",
      tokens: 310_000,
      window: 1_000_000,
      budget: 300_000,
      triggerAt: 300_000,
      phase: "prepare",
      preparing: false,
      digestReady: false,
      lastCompactedAt: null,
      compactions: 0,
      stalled: false
    }
    expect(
      Schema.decodeUnknownSync(ContextSnapshot)(Schema.encodeSync(ContextSnapshot)(snapshot))
    ).toStrictEqual(snapshot)
  })

  it("ships with auto-compaction on and a mid-band budget", () => {
    expect(DEFAULT_CONTEXT_CONFIG.auto).toBe(true)
    expect(DEFAULT_CONTEXT_CONFIG.budgetTokens).toBe(DEFAULT_BUDGET_TOKENS)
    expect(Either.isRight(Schema.decodeUnknownEither(ContextConfig)(DEFAULT_CONTEXT_CONFIG))).toBe(true)
  })

  // The band is enforced at the schema boundary too, so a hand-edited
  // config.json can't put a session outside it.
  it("rejects a budget outside the usable band at the schema boundary", () => {
    expect(
      Either.isLeft(Schema.decodeUnknownEither(ContextConfig)({ auto: true, budgetTokens: 50_000 }))
    ).toBe(true)
    expect(
      Either.isLeft(Schema.decodeUnknownEither(ContextConfig)({ auto: true, budgetTokens: 900_000 }))
    ).toBe(true)
  })
})
