import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppPaths,
  CliAdapter,
  ConfigService,
  DiscoveryService,
  GhService,
  ReviewService,
  ReviewStore,
  SessionStore,
  SkillsService,
  TerminalService,
  WorkspaceService
} from "@starbase/cli-adapters"
import type { AgentContext, CliAdapterShape, SessionSpec } from "@starbase/cli-adapters"
import { appPathsFor, fakeCommandExecutor } from "@starbase/cli-adapters/test-support"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DialogService } from "./dialog.js"
import {
  chooseReposDir,
  configGet,
  createTerminal,
  githubDetectPr,
  githubPr,
  reviewRun,
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
      Layer.succeed(AppPaths, appPathsFor(root)),
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

  /**
   * No harness discovered — which keeps this hermetic. The real DiscoveryService
   * would find the operator's actual `claude` binary, and listing skills asks the
   * harness what it offers, so the test would spawn a CLI.
   */
  const noHarnesses = Layer.succeed(
    DiscoveryService,
    new DiscoveryService({ list: () => Effect.succeed([]) })
  )

  describe("Skills.list", () => {
    // An unknown session must not error — the `/` menu just has nothing to add.
    it("resolves for an unknown session, rather than failing", async () => {
      const skills = await Effect.runPromise(
        skillsList("nope").pipe(
          Effect.provide(
            Layer.mergeAll(base, SessionStore.Default, SkillsService.Default, noHarnesses)
          )
        )
      )
      // No session → no worktree to scan, and no harness discovered → nothing to
      // ask. Whatever the operator's real ~/.claude/skills holds may still be
      // scanned, so we assert the CONTRACT rather than a count: it resolves, and
      // it never conjures a command the harness doesn't have. `/plan`, `/test`
      // and `/commit` used to be served from a hardcoded list; none are real.
      expect(Array.isArray(skills)).toBe(true)
      expect(skills.map((s) => s.name)).not.toContain("/plan")
      expect(skills.map((s) => s.name)).not.toContain("/test")
      expect(skills.map((s) => s.name)).not.toContain("/commit")
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

  describe("Terminal.create", () => {
    // The renderer stays oblivious to worktree paths: the handler resolves cwd
    // (explicit cwd wins; otherwise the session's worktree; otherwise the
    // process cwd). Uses a real PTY, always reclaimed via killAll.
    const runCreate = (input: { sessionId: string; cwd?: string; cols: number; rows: number }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const info = yield* createTerminal(input)
          yield* Effect.flatMap(TerminalService, (t) => t.killAll) // reclaim the PTY
          return info
        }).pipe(Effect.provide(Layer.mergeAll(base, SessionStore.Default, TerminalService.Default)))
      )

    it("spawns in an explicit cwd when one is given", async () => {
      const info = await runCreate({ sessionId: "s1", cwd: dir, cols: 80, rows: 24 })
      expect(info.cwd).toBe(dir)
      expect(info.status).toBe("running")
      expect(info.sessionId).toBe("s1")
    })

    it("falls back to the process cwd for an unknown session with no cwd", async () => {
      const info = await runCreate({ sessionId: "nope", cols: 80, rows: 24 })
      expect(info.cwd).toBe(process.cwd())
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

  /**
   * The head-SHA short-circuit is what makes the auto-review trigger safe to
   * fire off a poll loop: an unchanged PR must cost a cheap `gh pr view`, never
   * an agent run. These tests count reviewer spawns to assert that as a fact
   * rather than an intention.
   */
  describe("Review.run", () => {
    /** Persist a session with a linked PR by writing the store's own file. */
    const withSession = (over: Record<string, unknown> = {}) => {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "s1",
            repo: "widget",
            branch: "feature",
            title: "Feature",
            status: "idle",
            cli: "claude",
            diff: { added: 0, removed: 0 },
            prNumber: 42,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-16T10:00:00.000Z",
            worktreePath: join(root, "worktrees", "s1"),
            baseBranch: "main",
            ...over
          }
        ])
      )
    }

    /**
     * `gh` reporting a fixed head SHA + a non-empty diff, on a host where the
     * `claude` binary resolves. The binary matters: with no binary the reviewer
     * would be dispatched to the scripted stub, and ReviewService rejects that
     * rather than pass stub prose off as a review.
     */
    const fakeGh = (headSha: string) =>
      fakeCommandExecutor((cmd, args) => {
        if (cmd === "which" || cmd === "where") {
          return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
        }
        if (cmd !== "gh") return { stdout: "2.1.0" }
        if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: headSha }) }
        if (args[1] === "diff") return { stdout: "diff --git a/a.ts b/a.ts\n+x\n" }
        return { stdout: "" }
      })

    /** A reviewer stub that counts its runs and always reports one finding. */
    const countingAdapter = () => {
      const spawns: SessionSpec[] = []
      const layer = Layer.succeed(
        CliAdapter,
        CliAdapter.of({
          run: ((_id: string, spec: SessionSpec, ctx: AgentContext) =>
            Effect.gen(function* () {
              spawns.push(spec)
              yield* ctx.emit({
                _tag: "Assistant",
                text: '```json\n{"findings":[{"title":"A bug","severity":"major"}]}\n```'
              })
            })) as CliAdapterShape["run"],
          stop: () => Effect.void
        })
      )
      return { spawns, layer }
    }

    const envFor = (headSha: string, adapter: Layer.Layer<CliAdapter>) =>
      Layer.mergeAll(
        Layer.succeed(AppPaths, appPathsFor(root)),
        NodeContext.layer,
        fakeGh(headSha)
      ).pipe(
        (leaf) =>
          Layer.mergeAll(
            ConfigService.Default,
            SessionStore.Default,
            GhService.Default,
            ReviewStore.Default,
            ReviewService.Default,
            DiscoveryService.Default,
            adapter
          ).pipe(Layer.provideMerge(leaf))
      )

    it("fails with ReviewError when the session has no linked PR", async () => {
      withSession({ prNumber: null })
      const { layer } = countingAdapter()
      const exit = await Effect.runPromiseExit(
        reviewRun("s1", false).pipe(Effect.provide(envFor("abc", layer)))
      )
      expect(exit._tag).toBe("Failure")
    })

    it("fails with ReviewError for an unknown session", async () => {
      const { layer, spawns } = countingAdapter()
      const exit = await Effect.runPromiseExit(
        reviewRun("nope", false).pipe(Effect.provide(envFor("abc", layer)))
      )
      expect(exit._tag).toBe("Failure")
      expect(spawns).toHaveLength(0)
    })

    it("runs the reviewer and stores the review against the PR head", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      const review = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer)))
      )
      expect(spawns).toHaveLength(1)
      expect(review.headSha).toBe("sha-one")
      expect(review.findings).toHaveLength(1)
      // Fable is the default reviewer when nothing is configured.
      expect(review.model).toBe("claude-fable-5")
    })

    it("re-running on an unchanged head returns the stored review WITHOUT spawning a reviewer", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      const env = envFor("sha-one", layer)
      const first = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
      const second = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
      expect(spawns).toHaveLength(1)
      expect(second.createdAt).toBe(first.createdAt)
    })

    it("force re-runs even on an unchanged head", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      const env = envFor("sha-one", layer)
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
      await Effect.runPromise(reviewRun("s1", true).pipe(Effect.provide(env)))
      expect(spawns).toHaveLength(2)
    })

    it("re-reviews once the PR head advances", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer))))
      const second = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-two", layer)))
      )
      expect(spawns).toHaveLength(2)
      expect(second.headSha).toBe("sha-two")
    })

    it("honours a configured review model", async () => {
      withSession()
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "config.json"),
        JSON.stringify({
          reposDir: "/repos",
          createdAt: "2026-01-01T00:00:00.000Z",
          github: {
            enabled: true,
            autoCreatePr: false,
            autoDetectPr: true,
            reviewCli: "claude",
            reviewModel: "claude-opus-4-8"
          }
        })
      )
      const { layer, spawns } = countingAdapter()
      const review = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer)))
      )
      expect(review.model).toBe("claude-opus-4-8")
      expect(spawns[0]!.model).toBe("claude-opus-4-8")
    })
  })
})
