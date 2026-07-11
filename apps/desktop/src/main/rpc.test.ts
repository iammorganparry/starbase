import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppPaths, ConfigService } from "@starbase/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DialogService } from "./dialog.js"
import { chooseReposDir, configGet } from "./rpc.js"

/**
 * The RPC handlers own the app's error-folding policy: a config read error must
 * look like "not configured" (→ first-run setup), and a cancelled folder picker
 * must be a no-op. We run the real ConfigService against a temp root and fake
 * only the native dialog, asserting the outcomes the renderer depends on.
 */
describe("RPC handlers", () => {
  let dir: string
  let root: string
  let base: Layer.Layer<ConfigService | AppPaths | NodeContext.NodeContext>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starbase-rpc-"))
    root = join(dir, "starbase")
    base = Layer.mergeAll(
      ConfigService.Default,
      Layer.succeed(AppPaths, {
        root,
        configFile: join(root, "config.json"),
        sessionsFile: join(root, "sessions.json"),
        worktreesDir: join(root, "worktrees")
      }),
      NodeContext.layer
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fakeDialog = (chosen: string | null) =>
    Layer.succeed(DialogService, { chooseDirectory: () => Effect.succeed(chosen) })

  describe("Config.get", () => {
    it("folds a malformed config to null (renderer shows first-run setup)", async () => {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, "config.json"), "{ not valid json ")
      const result = await Effect.runPromise(configGet().pipe(Effect.provide(base)))
      expect(result).toBeNull()
    })

    it("returns null when no config exists yet", async () => {
      const result = await Effect.runPromise(configGet().pipe(Effect.provide(base)))
      expect(result).toBeNull()
    })

    it("passes a persisted config straight through", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ConfigService.setReposDir("/Users/me/repos")
          return yield* configGet()
        }).pipe(Effect.provide(base))
      )
      expect(result?.reposDir).toBe("/Users/me/repos")
    })
  })

  describe("Setup.chooseReposDir", () => {
    it("returns null and persists nothing when the dialog is cancelled", async () => {
      const result = await Effect.runPromise(
        chooseReposDir().pipe(Effect.provide(Layer.merge(base, fakeDialog(null))))
      )
      expect(result).toBeNull()
      expect(existsSync(join(root, "config.json"))).toBe(false)
    })

    it("persists the chosen directory and returns the new config", async () => {
      const result = await Effect.runPromise(
        chooseReposDir().pipe(Effect.provide(Layer.merge(base, fakeDialog("/Users/me/repos"))))
      )
      expect(result?.reposDir).toBe("/Users/me/repos")
      expect(existsSync(join(root, "config.json"))).toBe(true)
    })
  })
})
