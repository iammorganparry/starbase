import { FALLBACK_MODELS, defaultModel } from "@starbase/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ModelsService } from "./models.js"

/**
 * ModelsService fetches live from providers where possible and falls back to the
 * curated list otherwise. We assert the offline behaviour hermetically via
 * `cursor` (no provider API → always the fallback) so tests never hit the
 * network; the live Anthropic/OpenAI paths are exercised in the running app.
 */

const run = <A>(effect: Effect.Effect<A, never, ModelsService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ModelsService.Default)))

describe("ModelsService", () => {
  it("returns the curated fallback for a harness with no provider API (cursor)", async () => {
    const models = await run(ModelsService.list("cursor"))
    expect(models).toStrictEqual(FALLBACK_MODELS.cursor)
    expect(models[0]!.id).toBe(defaultModel("cursor"))
  })
})
