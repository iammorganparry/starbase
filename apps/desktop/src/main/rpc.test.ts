import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppPaths,
  CliAdapter,
  ConfigService,
  DiscoveryService,
  GhService,
  GitService,
  McpService,
  ModelsService,
  ReviewService,
  ReviewStore,
  AdversarialPlanService,
  PlanExecutor,
  PlanRoundStore,
  SessionStore,
  TranscriptStore,
  SkillsService,
  TerminalService,
  WorkspaceService
} from "@starbase/cli-adapters"
import type { AgentContext, CliAdapterShape, SessionSpec } from "@starbase/cli-adapters"
import type { Plan, StreamEvent } from "@starbase/core"
import { appPathsFor, fakeCommandExecutor } from "@starbase/cli-adapters/test-support"
import { NodeContext } from "@effect/platform-node"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DialogService } from "./dialog.js"
import {
  chooseReposDir,
  configGet,
  createTerminal,
  githubDetectPr,
  githubSubmitReview,
  githubPr,
  mcpList,
  mcpStatus,
  modelsCatalog,
  modelsList,
  reviewGet,
  reviewMarkRouted,
  reviewReconcile,
  reviewRun,
  sessionDiff,
  skillsList,
  workspaceRevertFile,
  planAdversarial,
  planExecute,
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

  /**
   * `visibleModels` narrows the COMPOSER's menu. Letting it narrow Settings'
   * default-model picker too would make it a one-way door: curate down to a few
   * models and the rest can never be chosen as your default again, from the very
   * screen you'd use to un-curate. Configuration surfaces show what exists.
   *
   * It matters more than it looks: no UI writes `visibleModels` yet, so today the
   * only writer is a hand-edited `config.json` — which is exactly the user who
   * would get stuck.
   */
  describe("Models.list / Models.catalog — curation", () => {
    const CLAUDE_MODELS = [
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
      { id: "haiku", label: "haiku" }
    ]
    const models = Layer.succeed(
      ModelsService,
      new ModelsService({
        list: () => Effect.succeed(CLAUDE_MODELS),
        catalog: () =>
          Effect.succeed([{ cli: "claude" as const, label: "Claude Code", models: CLAUDE_MODELS }])
      })
    )
    const env = () => Layer.mergeAll(base, noHarnesses, models)

    /** Curate this session's harness down to a single model. */
    const curate = ConfigService.setProvider("claude", {
      enabled: true,
      defaultMode: "accept-edits",
      visibleModels: ["opus"]
    })

    it("honours curation in the composer's menu — the surface it's for", async () => {
      const catalog = await Effect.runPromise(
        Effect.gen(function* () {
          yield* curate
          return yield* modelsCatalog()
        }).pipe(Effect.provide(env()))
      )
      expect(catalog[0]?.models.map((m) => m.id)).toStrictEqual(["opus"])
    })

    it("NEVER narrows the Settings picker, so curation stays reversible", async () => {
      const list = await Effect.runPromise(
        Effect.gen(function* () {
          yield* curate
          return yield* modelsList("claude")
        }).pipe(Effect.provide(env()))
      )
      expect(list.map((m) => m.id)).toStrictEqual(["opus", "sonnet", "haiku"])
    })
  })

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

  /**
   * MCP handlers resolve the harness's OWN config dir. `STARBASE_HARNESS_HOME`
   * points them at a seeded fake `~` so these tests never read the developer's real
   * `~/.claude.json` — `STARBASE_HOME` can't do that job, since harness config lives
   * outside Starbase's state dir.
   */
  describe("Mcp.list / Mcp.status", () => {
    let harnessHome: string
    beforeEach(() => {
      harnessHome = join(dir, "fake-home")
      mkdirSync(harnessHome, { recursive: true })
      process.env.STARBASE_HARNESS_HOME = harnessHome
    })
    afterEach(() => {
      delete process.env.STARBASE_HARNESS_HOME
    })

    const env = () => Layer.mergeAll(base, SessionStore.Default, McpService.Default)

    const writeClaudeConfig = (servers: Record<string, unknown>) =>
      writeFileSync(join(harnessHome, ".claude.json"), JSON.stringify({ mcpServers: servers }))

    it("reads the seeded harness home rather than the real one", async () => {
      writeClaudeConfig({ seeded: { url: "https://seeded/mcp" } })
      const servers = await Effect.runPromise(mcpList(null, "claude").pipe(Effect.provide(env())))
      expect(servers.map((s) => s.name)).toStrictEqual(["seeded"])
    })

    /** Settings has no session: it passes cli explicitly and must still work. */
    it("resolves the harness from cli when there is no session", async () => {
      mkdirSync(join(harnessHome, ".cursor"), { recursive: true })
      writeFileSync(join(harnessHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { c: { url: "https://c" } } }))
      const servers = await Effect.runPromise(mcpList(null, "cursor").pipe(Effect.provide(env())))
      expect(servers.map((s) => s.name)).toStrictEqual(["c"])
      expect(servers[0]?.cli).toBe("cursor")
    })

    // An unknown session must not error — it falls back to Claude with no worktree.
    it("resolves for an unknown session rather than failing", async () => {
      writeClaudeConfig({ seeded: { url: "https://seeded/mcp" } })
      const servers = await Effect.runPromise(mcpList("nope", undefined).pipe(Effect.provide(env())))
      expect(servers.map((s) => s.name)).toStrictEqual(["seeded"])
    })

    it("returns [] when the harness has no MCP config at all", async () => {
      const servers = await Effect.runPromise(mcpList(null, "claude").pipe(Effect.provide(env())))
      expect(servers).toStrictEqual([])
    })

    /** The redaction contract, asserted at the boundary the renderer actually sees. */
    it("never sends env values across the RPC boundary", async () => {
      writeClaudeConfig({ secretive: { command: "srv", env: { API_KEY: "sk-live-DO-NOT-LEAK" } } })
      const servers = await Effect.runPromise(mcpList(null, "claude").pipe(Effect.provide(env())))
      expect(JSON.stringify(servers)).not.toContain("sk-live-DO-NOT-LEAK")
      expect(servers[0]?.envKeys).toStrictEqual(["API_KEY"])
    })

    it("reports status for a server that cannot be reached, without failing", async () => {
      writeClaudeConfig({ dead: { command: "/nonexistent/mcp-server" } })
      const statuses = await Effect.runPromise(mcpStatus(null, "claude", false).pipe(Effect.provide(env())))
      expect(statuses).toHaveLength(1)
      expect(statuses[0]?.name).toBe("dead")
      expect(statuses[0]?.state).toBe("failed")
    })

    it("returns [] from status when nothing is configured", async () => {
      const statuses = await Effect.runPromise(mcpStatus(null, "claude", false).pipe(Effect.provide(env())))
      expect(statuses).toStrictEqual([])
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

    it("anchors a session-less terminal to home, NOT the app's own directory", async () => {
      // This test used to assert the opposite — that the terminal fell back to
      // `process.cwd()`. That was the bug written down as a guarantee: the app's
      // cwd is, in development, whichever worktree `pnpm dev` was launched from,
      // so a terminal with no worktree opened *inside an unrelated repo* and
      // anything typed there ran against that repo's files.
      const info = await runCreate({ sessionId: "nope", cols: 80, rows: 24 })
      expect(info.cwd).toBe(homedir())
      expect(info.cwd).not.toBe(process.cwd())
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

  describe("Github.submitReview", () => {
    // Unlike the reads above, submitting is a user-initiated write: silently
    // succeeding on a session with no PR would swallow the reviewer's drafts
    // with no sign they went nowhere.
    it("fails rather than silently dropping drafts when no PR is linked", async () => {
      const gh = Layer.mergeAll(base, SessionStore.Default, GhService.Default)
      const exit = await Effect.runPromiseExit(
        githubSubmitReview({
          sessionId: "nope",
          comments: [{ path: "a.ts", line: 2, startLine: null, body: "c" }]
        }).pipe(Effect.provide(gh))
      )
      expect(exit._tag).toBe("Failure")
    })

    /**
     * The whole point of the handler: a draft written on a line becomes an
     * INLINE comment on that line, anchored to the PR's current head. Asserting
     * the JSON that actually reaches `gh` is the only way to know that — every
     * layer above it can look correct while posting a flattened blob.
     */
    it("posts anchorable drafts inline and folds the rest into the body", async () => {
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
            baseBranch: "main"
          }
        ])
      )

      let posted: { commit_id: string; body: string; comments: ReadonlyArray<Record<string, unknown>> } | null = null
      const gh = Layer.mergeAll(
        base,
        SessionStore.Default,
        GhService.Default,
        fakeCommandExecutor((cmd, args, stdin) => {
          if (cmd !== "gh") return { stdout: "" }
          if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "headsha" }) }
          // a.ts gains new-side lines 1-2; nothing else is in the diff.
          if (args[1] === "diff") {
            return {
              stdout: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " const x = 1", "+const y = 2"].join("\n")
            }
          }
          if (args[0] === "api") {
            posted = JSON.parse(stdin)
            return { exitCode: 0, stdout: "{}" }
          }
          return { stdout: "" }
        })
      )

      const unanchored = await Effect.runPromise(
        githubSubmitReview({
          sessionId: "s1",
          comments: [
            { path: "a.ts", line: 2, startLine: null, body: "on the diff" },
            { path: "a.ts", line: 99, startLine: null, body: "moved off the diff" }
          ]
        }).pipe(Effect.provide(gh))
      )

      expect(unanchored).toBe(1)
      expect(posted).not.toBeNull()
      expect(posted!.commit_id).toBe("headsha")
      expect(posted!.comments).toStrictEqual([
        { path: "a.ts", line: 2, side: "RIGHT", body: "on the diff" }
      ])
      // The stale one keeps its words instead of 422-ing the whole review.
      expect(posted!.body).toContain("moved off the diff")
      expect(posted!.body).toContain("a.ts:99")
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

    /**
     * Reconciliation credits the commits that fixed findings. What matters here
     * is the NULL contract: the renderer calls this after every settled turn, so
     * "nothing changed" must be distinguishable from "here is a review", or the
     * review pane re-renders on every turn for nothing.
     */
    describe("Review.reconcile", () => {
      /** `gh` as above, plus a `git log` whose output is the commits since the head. */
      const gitEnv = (headSha: string, log: string, adapter: Layer.Layer<CliAdapter>) =>
        Layer.mergeAll(
          Layer.succeed(AppPaths, appPathsFor(root)),
          NodeContext.layer,
          fakeCommandExecutor((cmd, args) => {
            if (cmd === "which" || cmd === "where") {
              return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
            }
            if (cmd === "git") return args[2] === "log" ? { stdout: log } : { stdout: "" }
            if (cmd !== "gh") return { stdout: "2.1.0" }
            if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: headSha }) }
            if (args[1] === "diff") return { stdout: "diff --git a/a.ts b/a.ts\n+x\n" }
            return { stdout: "" }
          })
        ).pipe(
          (leaf) =>
            Layer.mergeAll(
              ConfigService.Default,
              SessionStore.Default,
              GhService.Default,
              GitService.Default,
              ReviewStore.Default,
              ReviewService.Default,
              DiscoveryService.Default,
              adapter
            ).pipe(Layer.provideMerge(leaf))
        )

      /** `git log --reverse --name-only --pretty=format:%H\x1f%s` output. */
      const gitLog = (sha: string, subject: string, files: string[]) =>
        `${sha}\x1f${subject}\n${files.join("\n")}\n`

      it("returns null when there is no stored review", async () => {
        withSession()
        const { layer } = countingAdapter()
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(Effect.provide(gitEnv("sha-one", "", layer)))
        )
        expect(out).toBeNull()
      })

      it("credits the commit that touched the finding's file, and persists it", async () => {
        withSession()
        const { layer } = countingAdapter()
        // The stub reports one finding with no path, so anchor it by hand — the
        // attribution rule is path-based and a pathless finding never resolves.
        const seed = gitEnv("sha-one", "", layer)
        const stored = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(seed)))
        await Effect.runPromise(
          ReviewStore.set("s1", {
            ...stored,
            findings: [{ ...stored.findings[0]!, path: "src/auth.ts" }]
          }).pipe(Effect.provide(seed))
        )

        const env = gitEnv(
          "sha-one",
          gitLog("9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204", "fix(auth): timingSafeEqual", [
            "src/auth.ts"
          ]),
          layer
        )
        const out = await Effect.runPromise(reviewReconcile("s1").pipe(Effect.provide(env)))
        expect(out?.findings[0]?.resolvedBy).toMatchObject({
          sha: "9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204",
          subject: "fix(auth): timingSafeEqual"
        })
        // Persisted, not just returned — the next read must agree.
        const reread = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(env)))
        expect(reread?.findings[0]?.resolvedBy?.sha).toBe("9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204")
      })

      it("returns null when no commit touched a finding's file", async () => {
        withSession()
        const { layer } = countingAdapter()
        const seed = gitEnv("sha-one", "", layer)
        const stored = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(seed)))
        await Effect.runPromise(
          ReviewStore.set("s1", {
            ...stored,
            findings: [{ ...stored.findings[0]!, path: "src/auth.ts" }]
          }).pipe(Effect.provide(seed))
        )

        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(
            Effect.provide(gitEnv("sha-one", gitLog("aaa", "unrelated", ["src/other.ts"]), layer))
          )
        )
        expect(out).toBeNull()
      })

      it("returns null for a session with no worktree", async () => {
        withSession({ worktreePath: undefined })
        const { layer } = countingAdapter()
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(Effect.provide(gitEnv("sha-one", "", layer)))
        )
        expect(out).toBeNull()
      })
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

    /**
     * Posting the low-severity half to the PR.
     *
     * The payload's SHAPE is `planReviewPost`'s business and is pinned there
     * (review-post.test.ts) — the fake executor drains stdin, so the fed JSON
     * isn't observable here anyway. What these pin is the handler's job: does it
     * call GitHub at all, on which path, and what does it stamp on the review.
     */
    describe("posting to the PR", () => {
      /** A diff whose new side has lines 1–3, so a finding can actually anchor. */
      const POSTABLE_DIFF = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1,3 @@",
        " one",
        "+two",
        "+three"
      ].join("\n")

      /** `gh` that records every invocation, and can fail the review POST. */
      const recordingGh = (headSha: string, opts: { postFails?: boolean } = {}) => {
        const calls: Array<ReadonlyArray<string>> = []
        const layer = fakeCommandExecutor((cmd, args) => {
          if (cmd === "which" || cmd === "where") {
            return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
          }
          if (cmd !== "gh") return { stdout: "2.1.0" }
          calls.push([...args])
          if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: headSha }) }
          if (args[1] === "diff") return { stdout: POSTABLE_DIFF }
          if (args[0] === "api" && args.includes("--method")) {
            return opts.postFails
              ? { exitCode: 1, stderr: "HTTP 422: line must be part of the diff" }
              : { stdout: "{}" }
          }
          return { stdout: "" }
        })
        return { calls, layer }
      }

      /** A reviewer stub reporting exactly `findings`. */
      const adapterReporting = (findings: ReadonlyArray<Record<string, unknown>>) =>
        Layer.succeed(
          CliAdapter,
          CliAdapter.of({
            run: ((_id: string, _spec: SessionSpec, ctx: AgentContext) =>
              ctx.emit({
                _tag: "Assistant",
                text: `\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``
              })) as CliAdapterShape["run"],
            stop: () => Effect.void
          })
        )

      const envWith = (gh: Layer.Layer<CommandExecutor.CommandExecutor>, adapter: Layer.Layer<CliAdapter>) =>
        Layer.mergeAll(Layer.succeed(AppPaths, appPathsFor(root)), NodeContext.layer, gh).pipe(
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

      const isReviewPost = (args: ReadonlyArray<string>) =>
        args[0] === "api" && args.some((a) => a.endsWith("/reviews"))

      it("posts the minor/nit findings and stamps postedAt", async () => {
        withSession()
        const { calls, layer: gh } = recordingGh("sha-one")
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(gh, adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }]))
            )
          )
        )
        expect(calls.filter(isReviewPost)).toHaveLength(1)
        expect(review.postedAt).not.toBeNull()
        expect(review.postError).toBeNull()
      })

      // The critical/major half belongs to the agent. Posting it here would both
      // duplicate it and turn the reviewer into a PR spammer.
      it("posts nothing when every finding is critical or major", async () => {
        withSession()
        const { calls, layer: gh } = recordingGh("sha-one")
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(gh, adapterReporting([{ title: "Data loss", severity: "critical", path: "a.ts", line: 2 }]))
            )
          )
        )
        expect(calls.filter(isReviewPost)).toHaveLength(0)
        expect(review.postedAt).toBeNull()
        expect(review.postError).toBeNull()
      })

      /**
       * The best-effort guarantee. Failing the run instead would throw away a
       * review that cost real tokens AND (because the caller only persists on
       * success) leave the auto-trigger re-spawning the reviewer every tick.
       */
      it("keeps the review and records postError when GitHub rejects the post", async () => {
        withSession()
        const { layer: gh } = recordingGh("sha-one", { postFails: true })
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(gh, adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }]))
            )
          )
        )
        expect(review.findings).toHaveLength(1)
        expect(review.postedAt).toBeNull()
        expect(review.postError).toContain("HTTP 422")
      })

      it("persists the failed post so the UI still sees it after a reload", async () => {
        withSession()
        const { layer: gh } = recordingGh("sha-one", { postFails: true })
        const env = envWith(
          gh,
          adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }])
        )
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        const stored = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(env)))
        expect(stored?.postError).toContain("HTTP 422")
      })

      /**
       * The de-dupe path must not re-post. Without this the auto-review poll
       * would add the same nits to the PR every 60 seconds, forever.
       */
      it("does not re-post when the head is unchanged", async () => {
        withSession()
        const { calls, layer: gh } = recordingGh("sha-one")
        const env = envWith(
          gh,
          adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }])
        )
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        expect(calls.filter(isReviewPost)).toHaveLength(1)
      })
    })

    /**
     * The stamp that makes auto-routing idempotent across reloads. The renderer
     * does the routing (it owns the conversation actor); main only remembers.
     */
    describe("Review.markRouted", () => {
      const env = () =>
        Layer.mergeAll(Layer.succeed(AppPaths, appPathsFor(root)), NodeContext.layer, fakeGh("sha-one")).pipe(
          (leaf) =>
            Layer.mergeAll(
              ConfigService.Default,
              SessionStore.Default,
              GhService.Default,
              ReviewStore.Default,
              ReviewService.Default,
              DiscoveryService.Default,
              countingAdapter().layer
            ).pipe(Layer.provideMerge(leaf))
        )

      it("stamps an unrouted review and persists it", async () => {
        withSession()
        const layer = env()
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(layer)))
        const stamp = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(layer)))
        expect(stamp).not.toBeNull()
        const stored = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(layer)))
        expect(stored?.routedAt).toBe(stamp)
      })

      /**
       * The renderer calls this from an effect, and an effect can fire twice
       * (StrictMode, two panes on one session). The stamp is a fact about the
       * FIRST routing — a second call must not move it.
       */
      it("keeps the original stamp when called again", async () => {
        withSession()
        const layer = env()
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(layer)))
        const first = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(layer)))
        const second = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(layer)))
        expect(second).toBe(first)
      })

      // Null, not a stamp: claiming "routed" for a review that doesn't exist
      // would leave findings reading as sent that no agent ever heard about.
      it("returns null when there is no stored review", async () => {
        withSession()
        const stamp = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(env())))
        expect(stamp).toBeNull()
      })

      /**
       * The end-to-end refutation of "a failed persist makes markRouted return
       * null forever, so routing re-sends indefinitely".
       *
       * It can't. `ReviewStore.set` updates its in-memory mirror UNCONDITIONALLY
       * (that write is the de-dupe's brake and provably cannot fail), and only
       * the DISK write is best-effort. So a `reviewRun` whose reviews dir is
       * unwritable still leaves the mirror holding the review — and
       * `reviewMarkRouted`, which reads through the same process's mirror, stamps
       * it just fine. The disk failure costs durability across a restart, not the
       * stamp; and across a restart the renderer re-reads null too, so it never
       * routes a review main has forgotten.
       */
      it("stamps a routedAt even when the reviews dir is unwritable", async () => {
        withSession()
        // A file where the reviews DIRECTORY should be → every write beneath it
        // fails, exactly like a permissions/full-disk failure.
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "reviews"), "not a directory")
        // BOTH calls under ONE layer build, which is the whole point: production
        // runs every RPC on a single `ManagedRuntime.make(AppLayer)`, so the
        // ReviewStore — and its in-memory mirror — is a process singleton shared
        // across reviewRun and reviewMarkRouted. Providing the layer per
        // `runPromise` would build a fresh, empty mirror each time and prove
        // nothing about the real code.
        const stamp = await Effect.runPromise(
          Effect.gen(function* () {
            yield* reviewRun("s1", false)
            return yield* reviewMarkRouted("s1")
          }).pipe(Effect.provide(env()))
        )
        expect(stamp).not.toBeNull()
      })
    })
  })
})

/**
 * The round → approve path, end to end through the two handlers that own it.
 *
 * This is the flow the feature exists for and it was untested: `Plan.adversarial`
 * streamed its plan to the screen while `Plan.execute` re-read the approved plan
 * from the transcript, so nothing connected them. The operator saw a plan,
 * approved it, and was told it was "no longer in this session".
 */
describe("Gigaplan round persistence", () => {
  let dir: string
  let root: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starbase-round-"))
    root = join(dir, "starbase")
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, "sessions.json"),
      JSON.stringify([
        {
          id: SESSION,
          repo: "widget",
          branch: "b",
          title: "t",
          status: "idle",
          cli: "starbase",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: "2026-07-19T00:00:00.000Z",
          worktreePath: root
        }
      ])
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const SESSION = "s_round"

  /**
   * Everything `planAdversarial` touches, against a real temp root so the
   * transcript write is a real write rather than a mock that always agrees.
   */
  const roundLayer = (r: string) =>
    Layer.mergeAll(
      Layer.succeed(AppPaths, appPathsFor(r)),
      NodeContext.layer,
      ConfigService.Default,
      GitService.Default,
      TranscriptStore.Default,
      PlanRoundStore.Default,
      SessionStore.Default,
      Layer.succeed(DiscoveryService, new DiscoveryService({ list: () => Effect.succeed([]) })),
      Layer.succeed(
        ModelsService,
        new ModelsService({
          list: () => Effect.succeed([]),
          catalog: () => Effect.succeed([])
        })
      ),
      fakeCommandExecutor(() => ({ exitCode: 0, stdout: "" })),
      // Never reached — the round is faked — but it is in the handler's
      // environment, so the test has to satisfy the same contract the app does.
      Layer.succeed(
        CliAdapter,
        CliAdapter.of({
          run: (() => Effect.void) as unknown as CliAdapterShape["run"],
          stop: (() => Effect.void) as unknown as CliAdapterShape["stop"]
        })
      ),
      fakeService
    )


  /**
   * Spelled out in full rather than cast from a partial literal. A fixture that
   * only satisfies the TYPE can still fail to DECODE off disk, and decoding is
   * the half of the round trip this test exists to check — an `as Plan` cast
   * here would have made the test pass against a transcript the app cannot read.
   */
  const PLAN: Plan = {
    id: "plan_1",
    summary: "Add rate limiting",
    steps: [
      {
        id: "s1",
        number: "01",
        title: "Add the limiter",
        intent: "throttle refunds",
        approach: [],
        kind: "step",
        condition: null,
        parentId: null,
        dependsOn: [],
        blocks: [],
        files: [],
        guards: [],
        code: null,
        diff: null,
        status: "proposed",
        flagged: false
      }
    ],
    comments: [],
    status: "proposed",
    structured: true,
    raw: "summary: Add rate limiting"
  }

  /** Stands in for the round: emits the plan the real service would produce. */
  /** The executor is faked: this is about persistence, not about running steps. */
  const fakeExecutor = Layer.succeed(
    PlanExecutor,
    new PlanExecutor({
      run: (input: {
        plan: Plan
        onStepDone?: (step: Plan["steps"][number]) => Effect.Effect<void>
      }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // A real executor reports each finished step; the fake does too, or
            // the wiring under test is never exercised.
            const first = input.plan.steps[0]
            if (first !== undefined && input.onStepDone !== undefined) {
              yield* input.onStepDone(first)
            }
            return Stream.fromIterable([
              { _tag: "Assistant", text: "ran step 01" } as unknown as StreamEvent,
              { _tag: "Done", costUsd: 0, tokens: 0 } as unknown as StreamEvent
            ])
          })
        )
    } as unknown as ConstructorParameters<typeof PlanExecutor>[0])
  )

  const execLayer = (r: string) => Layer.mergeAll(roundLayer(r), fakeExecutor)

  const fakeService = Layer.succeed(
    AdversarialPlanService,
    new AdversarialPlanService({
      run: () =>
        Stream.fromIterable([
          { _tag: "PlanProposed", plan: PLAN } as StreamEvent,
          { _tag: "Done", costUsd: 0, tokens: 0, sessionId: SESSION } as unknown as StreamEvent
        ])
    } as unknown as ConstructorParameters<typeof AdversarialPlanService>[0])
  )

  it("writes the round's plan into the transcript, so approving it can find it", async () => {
    const found = await Effect.gen(function* () {
      yield* planAdversarial(SESSION, "Add rate limiting to refunds.").pipe(Stream.runDrain)
      const messages = yield* TranscriptStore.list(SESSION)
      // The plan must be reachable exactly the way `planExecute` reaches it.
      return messages.flatMap((m) =>
        m.parts.flatMap((p) => (p._tag === "Plan" && p.plan.id === PLAN.id ? [p.plan] : []))
      )
    }).pipe(Effect.provide(roundLayer(root)), Effect.runPromise)

    expect(found).toHaveLength(1)
    expect(found[0]?.summary).toBe("Add rate limiting")
  })

  it("keeps the operator's brief, so a reopened session shows what was asked", async () => {
    const texts = await Effect.gen(function* () {
      yield* planAdversarial(SESSION, "Add rate limiting to refunds.").pipe(Stream.runDrain)
      const messages = yield* TranscriptStore.list(SESSION)
      return messages.filter((m) => m.role === "user").map((m) => m.parts)
    }).pipe(Effect.provide(roundLayer(root)), Effect.runPromise)

    expect(JSON.stringify(texts)).toContain("Add rate limiting to refunds.")
  })

  /**
   * Approving is a durable act, not a screen state.
   *
   * `settleLoaded` rewrites a still-`proposed` plan to `stale` on the next
   * transcript load. So a plan that was approved and RAN, but whose approval was
   * only ever held in the renderer, comes back looking like one that never
   * started — and can be approved a second time, running the whole thing again.
   */
  it("records the approval, so a completed plan doesn't come back as stale", async () => {
    const status = await Effect.gen(function* () {
      // Seed the approved-from plan the way a finished round leaves it.
      yield* TranscriptStore.append(SESSION, {
        id: `a_${SESSION}_1`,
        role: "assistant",
        parts: [{ _tag: "Plan", plan: PLAN }],
        streaming: false,
        createdAt: "2026-07-19T00:00:00.000Z"
      })
      yield* planExecute(SESSION, PLAN.id).pipe(Stream.runDrain)
      const messages = yield* TranscriptStore.list(SESSION)
      return messages.flatMap((m) =>
        m.parts.flatMap((p) => (p._tag === "Plan" && p.plan.id === PLAN.id ? [p.plan.status] : []))
      )
    }).pipe(Effect.provide(execLayer(root)), Effect.runPromise)

    expect(status).toStrictEqual(["approved"])
  })

  it("persists the execution's own turns, so the run survives a reopen", async () => {
    const roles = await Effect.gen(function* () {
      yield* TranscriptStore.append(SESSION, {
        id: `a_${SESSION}_1`,
        role: "assistant",
        parts: [{ _tag: "Plan", plan: PLAN }],
        streaming: false,
        createdAt: "2026-07-19T00:00:00.000Z"
      })
      yield* planExecute(SESSION, PLAN.id).pipe(Stream.runDrain)
      const messages = yield* TranscriptStore.list(SESSION)
      return messages.map((m) => m.role)
    }).pipe(Effect.provide(execLayer(root)), Effect.runPromise)

    // The seeded plan turn, plus the approval turn and the run's own turn.
    expect(roles).toStrictEqual(["assistant", "user", "assistant"])
  })

  it("ticks a finished step on the stored plan, so a crash mid-run loses only the tail", () => {
    // `planExecute` marks the plan `approved` BEFORE the run so it can't be
    // approved twice. Without per-step persistence that combination is the
    // worst of both: an approved plan, a half-applied worktree, and no record
    // of which steps actually ran.
    return Effect.gen(function* () {
      yield* TranscriptStore.append(SESSION, {
        id: `a_${SESSION}_1`,
        role: "assistant",
        parts: [{ _tag: "Plan", plan: PLAN }],
        streaming: false,
        createdAt: "2026-07-19T00:00:00.000Z"
      })
      yield* planExecute(SESSION, PLAN.id).pipe(Stream.runDrain)
      const messages = yield* TranscriptStore.list(SESSION)
      const stored = messages.flatMap((m) =>
        m.parts.flatMap((p) => (p._tag === "Plan" && p.plan.id === PLAN.id ? [p.plan] : []))
      )[0]
      expect(stored?.steps[0]?.status).toBe("done")
    }).pipe(Effect.provide(execLayer(root)), Effect.runPromise)
  })
})
