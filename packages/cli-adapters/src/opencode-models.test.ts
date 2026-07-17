import { describe, expect, it } from "vitest"
import { filterVisible } from "./models.js"
import { toModelOptions } from "./opencode-models.js"
import type { OpencodeProvider } from "./opencode-models.js"

/**
 * The live path boots a real opencode server, so we test the PURE seam — the
 * `/config/providers` fold that the model chip renders, and the curation that
 * makes it usable. Fixtures mirror a real 1.18 response.
 */

const providers: ReadonlyArray<OpencodeProvider> = [
  {
    id: "opencode",
    name: "opencode",
    source: "custom",
    models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } }
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    source: "env",
    models: {
      "anthropic/claude-opus-4.5": { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5" },
      "aion-labs/aion-2.0": { id: "aion-labs/aion-2.0", name: "Aion-2.0" }
    }
  }
]

describe("toModelOptions", () => {
  /**
   * The id must stay provider-qualified because that is what opencode itself
   * takes — and an OpenRouter model id already contains slashes, so the result
   * is three segments. `splitModelId` is what puts it back together.
   */
  it("qualifies ids with the provider, preserving slashes in the model id", () => {
    const ids = toModelOptions(providers).map((m) => m.id)
    expect(ids).toContain("openrouter/anthropic/claude-opus-4.5")
    expect(ids).toContain("opencode/big-pickle")
  })

  /**
   * The menu groups by HARNESS, so every opencode model shares one section.
   * A bare "Claude Opus 4.5" would be ambiguous the moment the same model is
   * reachable through both Zen and OpenRouter.
   */
  it("disambiguates labels by provider", () => {
    const opus = toModelOptions(providers).find((m) => m.id === "openrouter/anthropic/claude-opus-4.5")
    expect(opus?.label).toBe("openrouter · Claude Opus 4.5")
  })

  it("floats each provider's own default to the top", () => {
    const options = toModelOptions(providers, {
      openrouter: "anthropic/claude-opus-4.5",
      opencode: "big-pickle"
    })
    // Both defaults come first; the rest sort alphabetically behind them.
    expect(options.slice(0, 2).map((m) => m.id).sort()).toStrictEqual([
      "opencode/big-pickle",
      "openrouter/anthropic/claude-opus-4.5"
    ])
    expect(options[options.length - 1]?.id).toBe("openrouter/aion-labs/aion-2.0")
  })

  it("falls back to the raw id when a model has no display name", () => {
    const options = toModelOptions([
      { id: "custom", name: "Custom", models: { thing: { id: "thing" } } }
    ])
    expect(options).toStrictEqual([{ id: "custom/thing", label: "custom · thing" }])
  })

  it("survives a provider with no models rather than throwing", () => {
    expect(toModelOptions([{ id: "empty", name: "Empty", models: {} }])).toStrictEqual([])
  })
})

describe("filterVisible", () => {
  const models = [
    { id: "opencode/big-pickle", label: "opencode · Big Pickle" },
    { id: "openrouter/anthropic/claude-opus-4.5", label: "openrouter · Claude Opus 4.5" }
  ]

  it("narrows to the curated ids", () => {
    expect(filterVisible(models, ["opencode/big-pickle"])).toStrictEqual([models[0]])
  })

  /** No curation means the user hasn't chosen — so we don't presume to choose. */
  it("shows everything when curation is absent or empty", () => {
    expect(filterVisible(models, undefined)).toStrictEqual(models)
    expect(filterVisible(models, [])).toStrictEqual(models)
  })

  /**
   * Model ids move upstream. A curation that has gone entirely stale must not
   * leave the user staring at an empty menu that looks like a broken harness —
   * showing too much is recoverable, showing nothing isn't.
   */
  it("falls back to the full list when curation matches nothing", () => {
    expect(filterVisible(models, ["openrouter/model-that-was-renamed"])).toStrictEqual(models)
  })
})
