import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FALLBACK_MODELS, ModelOption, defaultModel } from "./models.js"

/**
 * Model options cross the RPC boundary (the composer's model chip). What matters:
 * the schema round-trips, every harness has at least one fallback, and the
 * default is the first fallback option.
 */

describe("ModelOption", () => {
  it("round-trips through encode → decode", () => {
    const option: ModelOption = { id: "opus", label: "opus" }
    expect(Schema.decodeUnknownSync(ModelOption)(Schema.encodeSync(ModelOption)(option))).toStrictEqual(option)
  })

  it("rejects a malformed option", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(ModelOption)({ id: 5 }))).toBe(true)
  })
})

describe("FALLBACK_MODELS / defaultModel", () => {
  it("gives every harness a non-empty fallback list", () => {
    expect(FALLBACK_MODELS.claude.length).toBeGreaterThan(0)
    expect(FALLBACK_MODELS.codex.length).toBeGreaterThan(0)
    expect(FALLBACK_MODELS.cursor.length).toBeGreaterThan(0)
  })

  it("defaults to the first fallback option per harness", () => {
    expect(defaultModel("claude")).toBe(FALLBACK_MODELS.claude[0]!.id)
    expect(defaultModel("claude")).toBe("opus")
    expect(defaultModel("codex")).toBe(FALLBACK_MODELS.codex[0]!.id)
  })
})
