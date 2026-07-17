import { describe, expect, it } from "vitest"
import { toProviderInfos } from "./opencode-auth.js"
import type { OpencodeProvider } from "./opencode-models.js"

/**
 * Writing a key needs a live server (verified live: `auth.set` returns true and
 * writes opencode's own `auth.json`), so we test the PURE seam — the fold that
 * Settings · Providers renders.
 *
 * The shapes below mirror a real 1.18 server:
 *  - `GET /provider` → every provider opencode knows (~167) + `connected`
 *  - `GET /config/providers` → only the ones that RESOLVE, with a true `source`
 */

/** The registry: everything opencode knows, connected or not. */
const all: ReadonlyArray<OpencodeProvider> = [
  { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: { a: { id: "a" } } },
  { id: "opencode", name: "OpenCode Zen", env: ["OPENCODE_API_KEY"], models: { z: { id: "z" } } },
  { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: { c: { id: "c" } } }
]

/** What actually resolves, with the credential's real origin. */
const configured: ReadonlyArray<OpencodeProvider> = [
  {
    id: "openrouter",
    name: "OpenRouter",
    source: "env",
    env: ["OPENROUTER_API_KEY"],
    models: { a: { id: "a" }, b: { id: "b" } }
  },
  { id: "opencode", name: "OpenCode Zen", source: "custom", env: ["OPENCODE_API_KEY"], models: { z: { id: "z" } } }
]

describe("toProviderInfos", () => {
  const infos = toProviderInfos(all, ["openrouter", "opencode"], configured)
  const byId = (id: string) => infos.find((p) => p.id === id)

  it("carries a connected provider's credential origin through", () => {
    expect(byId("openrouter")?.source).toBe("env")
    expect(byId("opencode")?.source).toBe("custom")
  })

  /**
   * THE reason this fold takes the registry at all. `/config/providers` lists
   * only providers that already work, so on its own you could never add a key
   * for one you haven't configured — to add OpenRouter you'd need OpenRouter
   * already working. An unconnected provider must still be listed, sourceless,
   * which is what renders the "Add key" affordance.
   */
  it("lists a known-but-unconnected provider as sourceless, so a key can be added", () => {
    expect(byId("anthropic")).toStrictEqual({
      id: "anthropic",
      name: "Anthropic",
      source: null,
      env: ["ANTHROPIC_API_KEY"],
      modelCount: 0
    })
  })

  /**
   * The registry's own `source` is NOT a connected-signal — a real server stamps
   * 166 of 167 as "custom" regardless. Only `connected` says what resolves.
   */
  it("ignores the registry's own source field in favour of `connected`", () => {
    const infos = toProviderInfos(
      [{ id: "anthropic", name: "Anthropic", source: "custom", env: [], models: {} }],
      [],
      []
    )
    expect(infos[0]?.source).toBeNull()
  })

  it("falls back to `api` for a connected provider /config/providers didn't detail", () => {
    // It resolved from somewhere, and a key in opencode's own store is the
    // likeliest somewhere — but never report it as unconfigured.
    const infos = toProviderInfos(all, ["anthropic"], [])
    expect(infos.find((p) => p.id === "anthropic")?.source).toBe("api")
  })

  it("counts only the models a provider RESOLVES, not what it could", () => {
    // OpenRouter resolves 2 per /config/providers, even though the registry
    // lists 1 — the live read wins.
    expect(byId("openrouter")?.modelCount).toBe(2)
    // Anthropic is in the registry with a model, but resolves none.
    expect(byId("anthropic")?.modelCount).toBe(0)
  })

  it("reports the env vars a provider reads, so the UI can name the one to set", () => {
    expect(byId("anthropic")?.env).toStrictEqual(["ANTHROPIC_API_KEY"])
  })

  /** The ones actually doing work belong at the top; alphabetical within a group. */
  it("sorts connected first, then by name", () => {
    expect(infos.map((p) => p.id)).toStrictEqual([
      // connected, alphabetical by NAME ("OpenCode Zen" < "OpenRouter")
      "opencode",
      "openrouter",
      // then the rest
      "anthropic"
    ])
  })

  it("tolerates missing fields rather than throwing", () => {
    const infos = toProviderInfos([{ id: "zed" }] as unknown as ReadonlyArray<OpencodeProvider>)
    expect(infos).toStrictEqual([{ id: "zed", name: "zed", source: null, env: [], modelCount: 0 }])
  })

  it("is empty when opencode knows nothing", () => {
    expect(toProviderInfos([], [], [])).toStrictEqual([])
  })
})
