import { describe, expect, it } from "vitest"
import type { CodexModel } from "./codex-models.js"
import { fetchCodexModels, toModelOptions } from "./codex-models.js"

/**
 * The `model/list` → chip-option mapping is the pure seam (the stdio handshake
 * itself is verified against a real `codex` binary). Shapes below mirror an
 * actual response from codex-cli 0.144.1.
 */

const model = (over: Partial<CodexModel> & { id: string }): CodexModel => ({ ...over })

describe("toModelOptions", () => {
  it("labels each model with its display name", () => {
    expect(toModelOptions([model({ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" })])).toStrictEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }
    ])
  })

  it("falls back to the id when a display name is absent", () => {
    expect(toModelOptions([model({ id: "gpt-5.5" })])).toStrictEqual([{ id: "gpt-5.5", label: "gpt-5.5" }])
  })

  // Callers (defaultModel, the composer's fallback) treat index 0 as the
  // default, so the CLI's own default has to lead — regardless of list order.
  it("puts the harness's default model first", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.4" }),
      model({ id: "gpt-5.6-sol", isDefault: true }),
      model({ id: "gpt-5.5" })
    ])
    expect(options[0]!.id).toBe("gpt-5.6-sol")
  })

  it("preserves the server's order among non-default models", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.6-sol", isDefault: true }),
      model({ id: "gpt-5.6-terra" }),
      model({ id: "gpt-5.6-luna" })
    ])
    expect(options.map((o) => o.id)).toStrictEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
  })

  // `codex-auto-review` ships hidden — it's an internal harness model, not
  // something to offer in the picker.
  it("drops hidden models", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.6-sol", isDefault: true }),
      model({ id: "codex-auto-review", hidden: true })
    ])
    expect(options.map((o) => o.id)).toStrictEqual(["gpt-5.6-sol"])
  })

  it("returns nothing for an empty catalogue", () => {
    expect(toModelOptions([])).toStrictEqual([])
  })
})

describe("fetchCodexModels", () => {
  // Discovery must never take the app down or hang it: a bogus binary has to
  // resolve null (→ FALLBACK_MODELS) rather than reject.
  it("resolves null when the binary does not exist", async () => {
    await expect(fetchCodexModels("/nonexistent/codex-does-not-exist")).resolves.toBeNull()
  })

  it("resolves null when the binary is not an app-server", async () => {
    await expect(fetchCodexModels("/bin/echo")).resolves.toBeNull()
  })
})
