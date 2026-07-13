import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppPaths,
  ConfigService,
  GhService,
  SessionStore,
  SkillsService,
  WorkspaceService
} from "@starbase/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DialogService } from "./dialog.js"
import {
  chooseReposDir,
  configGet,
  githubDetectPr,
  githubPr,
  sessionDiff,
  skillsList,
  workspaceRevertFile,
  workspaceRevertLines
} from "./rpc.js"

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
        worktreesDir: join(root, "worktrees"),
        transcriptsDir: join(root, "transcripts")
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

  describe("Config.setStarredRepos / setLastRepoPath", () => {
    // Saving stars / last-repo must round-trip and never drop other sections.
    it("persists starred repos and the last repo without dropping reposDir", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ConfigService.setReposDir("/Users/me/repos")
          yield* ConfigService.setStarredRepos(["/Users/me/repos/a", "/Users/me/repos/b"])
          yield* ConfigService.setLastRepoPath("/Users/me/repos/b")
          return yield* configGet()
        }).pipe(Effect.provide(base))
      )
      expect(result?.reposDir).toBe("/Users/me/repos")
      expect(result?.starredRepos).toEqual(["/Users/me/repos/a", "/Users/me/repos/b"])
      expect(result?.lastRepoPath).toBe("/Users/me/repos/b")
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

  describe("Skills.list", () => {
    // An unknown session must not error — the `/` menu still shows built-ins.
    it("falls back to the built-in commands for an unknown session", async () => {
      const skills = await Effect.runPromise(
        skillsList("nope").pipe(
          Effect.provide(Layer.mergeAll(base, SessionStore.Default, SkillsService.Default))
        )
      )
      expect(skills.length).toBeGreaterThan(0)
      expect(skills.some((s) => s.name === "/plan")).toBe(true)
    })
  })

  describe("Sessions.diff", () => {
    // An unknown session (or one without a worktree) yields no diff, not an error.
    it("returns an empty diff for an unknown session", async () => {
      const patch = await Effect.runPromise(
        sessionDiff("nope").pipe(
          Effect.provide(Layer.mergeAll(base, SessionStore.Default, WorkspaceService.Default))
        )
      )
      expect(patch).toBe("")
    })
  })

  describe("Workspace.revert*", () => {
    // Revert on an unknown / worktree-less session must be a safe no-op.
    it("no-ops for an unknown session (no worktree to touch)", async () => {
      const ws = Layer.mergeAll(base, SessionStore.Default, WorkspaceService.Default)
      await expect(
        Effect.runPromise(workspaceRevertFile({ sessionId: "nope", path: "a.ts" }).pipe(Effect.provide(ws)))
      ).resolves.toBeUndefined()
      await expect(
        Effect.runPromise(
          workspaceRevertLines({ sessionId: "nope", path: "a.ts", startLine: 1, endLine: 2 }).pipe(
            Effect.provide(ws)
          )
        )
      ).resolves.toBeUndefined()
    })
  })

  describe("Github.pr / Github.detectPr", () => {
    // A PR-less / unknown session must be a no-op (null), never an error, so the
    // renderer shows the empty "Create pull request" state.
    it("returns null for an unknown session without spawning gh", async () => {
      const gh = Layer.mergeAll(base, SessionStore.Default, GhService.Default)
      const pr = await Effect.runPromise(githubPr("nope").pipe(Effect.provide(gh)))
      expect(pr).toBeNull()
      const detected = await Effect.runPromise(githubDetectPr("nope").pipe(Effect.provide(gh)))
      expect(detected).toBeNull()
    })
  })
})
