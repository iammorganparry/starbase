import type { CliInfo } from "@starbase/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { UsageService } from "./usage.js"

/**
 * UsageService assembly. The live provider paths spawn their local harnesses, so
 * here we drive scripted mode (STARBASE_SCRIPTED_AGENT) to assert the hermetic
 * behaviour: installed harnesses appear, none claim live data, uninstalled ones
 * are dropped, and a `fetchedAt` stamp is always set. Live reads are covered by
 * the provider-specific usage tests.
 */

const cli = (kind: CliInfo["kind"], available: boolean): CliInfo => ({
  kind,
  label: kind,
  binPath: available ? `/usr/bin/${kind}` : null,
  version: null,
  available
})

const run = <A>(effect: Effect.Effect<A, never, UsageService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageService.Default)))

const withScripted = async <A>(fn: () => Promise<A>): Promise<A> => {
  const prev = process.env.STARBASE_SCRIPTED_AGENT
  process.env.STARBASE_SCRIPTED_AGENT = "1"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.STARBASE_SCRIPTED_AGENT
    else process.env.STARBASE_SCRIPTED_AGENT = prev
  }
}

describe("UsageService", () => {
  it("lists installed harnesses and stamps fetchedAt (scripted: no live data)", async () => {
    const usage = await withScripted(() =>
      run(UsageService.get([cli("claude", true), cli("codex", true)]))
    )
    expect(usage.providers.map((p) => p.cli)).toStrictEqual(["claude", "codex"])
    expect(usage.providers.every((p) => p.available === false)).toBe(true)
    expect(usage.fetchedAt).not.toBeNull()
  })

  it("omits harnesses that aren't installed", async () => {
    const usage = await withScripted(() =>
      run(UsageService.get([cli("claude", true), cli("cursor", false)]))
    )
    expect(usage.providers.map((p) => p.cli)).toStrictEqual(["claude"])
  })
})
