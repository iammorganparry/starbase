import type { CliInfo } from "@starbase/core"
import { FALLBACK_MODELS, defaultModel } from "@starbase/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ModelsService } from "./models.js"

/**
 * ModelsService fetches live from each harness where possible and falls back to
 * the curated list otherwise. We assert the offline behaviour hermetically via
 * `cursor` (no discovery path → always the fallback) so tests never hit the
 * network or spawn a CLI; the live Anthropic/Codex paths are exercised in the
 * running app (and Codex's mapping is unit-tested in `codex-models.test.ts`).
 */

const run = <A>(effect: Effect.Effect<A, never, ModelsService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ModelsService.Default)))

const cli = (kind: CliInfo["kind"], available: boolean): CliInfo => ({
  kind,
  label: kind,
  binPath: available ? `/usr/local/bin/${kind}` : null,
  version: available ? "1.0.0" : null,
  available
})

describe("ModelsService", () => {
  it("returns the curated fallback for a harness with no discovery path (cursor)", async () => {
    const models = await run(ModelsService.list("cursor"))
    expect(models).toStrictEqual(FALLBACK_MODELS.cursor)
    expect(models[0]!.id).toBe(defaultModel("cursor"))
  })

  /**
   * The startup prefetch (apps/desktop/src/main/index.ts) only pays off because
   * this cache is per-process and shared with the `Models.*` RPC handlers: warm
   * it at boot, and the composer's chip is a cache hit. If this stopped caching,
   * the prefetch would silently become dead weight and every session would probe
   * the Codex CLI again — so pin it.
   */
  it("caches a harness's models for the process lifetime", async () => {
    const models = await Effect.runPromise(
      Effect.gen(function* () {
        // First call resolves (and caches) against a binary that can't answer.
        const first = yield* ModelsService.list("codex", "/nonexistent/codex")
        // A later call is served from the cache — note it does NOT re-probe, even
        // though this one names a plausible binary.
        const second = yield* ModelsService.list("codex", "/usr/local/bin/codex")
        return { first, second }
      }).pipe(Effect.provide(ModelsService.Default))
    )
    expect(models.first).toStrictEqual(FALLBACK_MODELS.codex)
    expect(models.second).toBe(models.first)
  })

  describe("catalog", () => {
    // Offering a harness whose CLI isn't installed would only produce a session
    // that can't run — the menu must not list it.
    it("omits harnesses that aren't installed", async () => {
      const catalog = await run(
        ModelsService.catalog([cli("cursor", true), cli("codex", false), cli("claude", false)])
      )
      expect(catalog.map((p) => p.cli)).toStrictEqual(["cursor"])
    })

    it("returns nothing when no harness is installed", async () => {
      expect(await run(ModelsService.catalog([cli("cursor", false)]))).toStrictEqual([])
    })

    it("carries each harness's label and models for the menu section", async () => {
      const catalog = await run(ModelsService.catalog([cli("cursor", true)]))
      expect(catalog).toStrictEqual([
        { cli: "cursor", label: "cursor", models: FALLBACK_MODELS.cursor }
      ])
    })
  })
})
