import { writeFileSync } from "node:fs"
import { mkdirSync } from "node:fs"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { failureOf, runExit, withTempRoot } from "./test-support.js"

/**
 * ConfigService is the first-run persistence layer. We run it against a real
 * temp `~/starbase` and assert observable outcomes: what `get()` returns, what
 * ends up on disk, and how malformed input surfaces — never how it parses.
 */
describe("ConfigService", () => {
  let temp: ReturnType<typeof withTempRoot>
  beforeEach(() => {
    temp = withTempRoot()
  })
  afterEach(() => temp.cleanup())

  const provided = <A, E>(effect: Effect.Effect<A, E, ConfigService | AppPaths | FileSystem.FileSystem>) =>
    runExit(effect.pipe(Effect.provide(ConfigService.Default)), temp.layer)

  it("returns null before first-run setup (no config file)", async () => {
    const exit = await provided(ConfigService.get())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
  })

  it("persists the chosen repos dir and reads it back", async () => {
    const exit = await provided(
      Effect.gen(function* () {
        yield* ConfigService.setReposDir("/Users/me/repos")
        return yield* ConfigService.get()
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value?.reposDir).toBe("/Users/me/repos")
  })

  it("preserves createdAt across a second setReposDir", async () => {
    const exit = await provided(
      Effect.gen(function* () {
        const first = yield* ConfigService.setReposDir("/repos/a")
        const second = yield* ConfigService.setReposDir("/repos/b")
        return { first, second }
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.second.reposDir).toBe("/repos/b")
      expect(exit.value.second.createdAt).toBe(exit.value.first.createdAt)
    }
  })

  it("surfaces a malformed config.json as a ConfigError", async () => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(`${temp.root}/config.json`, "{ not valid json ")
    const exit = await provided(ConfigService.get())
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("ConfigError")
  })
})
