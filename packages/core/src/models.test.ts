import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_REVIEW_MODEL,
  FALLBACK_MODELS,
  ModelOption,
  defaultModel,
  reviewModelFor
} from "./models.js"

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

describe("DEFAULT_REVIEW_MODEL / reviewModelFor", () => {
  it("reviews with Fable on the Claude harness", () => {
    expect(DEFAULT_REVIEW_MODEL.claude).toBe("claude-fable-5")
  })

  // The reviewer's default is deliberately NOT the session's default: reviewing
  // a diff with the same model that wrote it defeats the point. This asserts the
  // two stay decoupled — adding Fable to the fallback list must never promote it
  // to index 0, where `defaultModel` would put every new session on it.
  it("keeps the review default distinct from the session default", () => {
    expect(DEFAULT_REVIEW_MODEL.claude).not.toBe(defaultModel("claude"))
  })

  it("offers Fable in the Claude fallback list without making it the session default", () => {
    expect(FALLBACK_MODELS.claude.map((m) => m.id)).toContain("claude-fable-5")
    expect(FALLBACK_MODELS.claude[0]!.id).not.toBe("claude-fable-5")
  })

  it("gives every harness a review model", () => {
    expect(reviewModelFor("claude")).toBe("claude-fable-5")
    expect(reviewModelFor("codex")).toBe("gpt-5.6-sol")
    expect(reviewModelFor("cursor")).toBe("auto")
  })

  // The review model has to be a model the harness will actually accept. This
  // caught nothing when the fallbacks were stale (`gpt-5-codex` was in both, and
  // both were wrong) — it's here so the two can't drift apart again.
  it("names a review model the harness offers", () => {
    for (const cli of ["claude", "codex", "cursor"] as const) {
      expect(FALLBACK_MODELS[cli].map((m) => m.id)).toContain(DEFAULT_REVIEW_MODEL[cli])
    }
  })

  it("honours a configured override", () => {
    expect(reviewModelFor("claude", "claude-opus-4-8")).toBe("claude-opus-4-8")
  })

  it("falls back when the override is empty", () => {
    expect(reviewModelFor("claude", "")).toBe("claude-fable-5")
    expect(reviewModelFor("claude", undefined)).toBe("claude-fable-5")
  })
})
