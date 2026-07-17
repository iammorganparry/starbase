import { describe, expect, it } from "vitest"
import { toProviderInfos } from "./opencode-auth.js"
import type { OpencodeProvider } from "./opencode-models.js"

/**
 * Writing a key needs a live server (verified live: `auth.set` returns true and
 * writes opencode's own `auth.json`), so we test the PURE seam — the fold that
 * Settings · Providers renders, including the `source` badge that tells the user
 * which credentials are theirs and which are ours.
 */

describe("toProviderInfos", () => {
  const providers: ReadonlyArray<OpencodeProvider> = [
    {
      id: "openrouter",
      name: "OpenRouter",
      source: "env",
      env: ["OPENROUTER_API_KEY"],
      models: { a: { id: "a" }, b: { id: "b" } }
    },
    { id: "opencode", name: "opencode", source: "custom", env: ["OPENCODE_API_KEY"], models: { z: { id: "z" } } }
  ]

  it("carries the credential's origin through, so the UI can show whose key it is", () => {
    const infos = toProviderInfos(providers)
    expect(infos.find((p) => p.id === "openrouter")?.source).toBe("env")
    expect(infos.find((p) => p.id === "opencode")?.source).toBe("custom")
  })

  it("reports the env vars a provider reads, so the UI can name the one to set", () => {
    expect(toProviderInfos(providers).find((p) => p.id === "openrouter")?.env).toStrictEqual([
      "OPENROUTER_API_KEY"
    ])
  })

  it("counts resolved models", () => {
    expect(toProviderInfos(providers).find((p) => p.id === "openrouter")?.modelCount).toBe(2)
  })

  /**
   * A provider with no credential is exactly the case Settings exists to fix, so
   * it must still be listed — with a null source, which is what renders the
   * "Add key" affordance.
   */
  it("keeps an unconfigured provider, marking it sourceless", () => {
    const infos = toProviderInfos([
      { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: {} }
    ])
    expect(infos).toStrictEqual([
      { id: "anthropic", name: "Anthropic", source: null, env: ["ANTHROPIC_API_KEY"], modelCount: 0 }
    ])
  })

  it("sorts by name and tolerates missing fields rather than throwing", () => {
    const infos = toProviderInfos([
      { id: "zed", name: "Zed", models: {} },
      { id: "acme", name: "Acme", models: {} }
    ] as ReadonlyArray<OpencodeProvider>)
    expect(infos.map((p) => p.id)).toStrictEqual(["acme", "zed"])
    expect(infos[0]?.env).toStrictEqual([])
  })
})
