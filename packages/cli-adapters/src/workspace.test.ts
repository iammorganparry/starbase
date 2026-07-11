import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { WorkspaceService } from "./workspace.js"
import { failureOf, initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * WorkspaceService scans a real directory of real git repos. We assert what the
 * sidebar would show — which repos are found, their order, branch, and derived
 * GitHub slug — plus the unconfigured failure. The scan's depth/ignore rules are
 * observed through their outcome (a nested repo isn't double-listed), not probed.
 */
describe("WorkspaceService", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("starbase-repos-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const services = Layer.mergeAll(WorkspaceService.Default, ConfigService.Default)

  const configureAnd = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkspaceService | ConfigService | AppPaths | NodeContext.NodeContext
    >
  ) =>
    runExit(
      Effect.gen(function* () {
        yield* ConfigService.setReposDir(repos.dir)
        return yield* effect
      }).pipe(Effect.provide(services)),
      temp.layer
    )

  it("fails with WorkspaceNotConfiguredError before setup", async () => {
    const exit = await runExit(
      WorkspaceService.listRepos().pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("WorkspaceNotConfiguredError")
  })

  it("lists discovered repos sorted by name, with branch + github slug", async () => {
    initGitRepo(join(repos.dir, "widget"), {
      remote: "git@github.com:acme/widget.git",
      initialBranch: "main"
    })
    initGitRepo(join(repos.dir, "athena"), { initialBranch: "develop" })

    const exit = await configureAnd(WorkspaceService.listRepos())
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    expect(exit.value.map((r) => r.name)).toStrictEqual(["athena", "widget"])
    const widget = exit.value.find((r) => r.name === "widget")!
    expect(widget.currentBranch).toBe("main")
    expect(widget.githubSlug).toBe("acme/widget")
    const athena = exit.value.find((r) => r.name === "athena")!
    expect(athena.currentBranch).toBe("develop")
    expect(athena.githubSlug).toBeNull()
  })

  it("stops at the first .git — a repo nested inside a repo is not double-listed", async () => {
    const outer = initGitRepo(join(repos.dir, "outer"), { initialBranch: "main" })
    // A nested git repo under the outer repo must NOT appear as its own entry.
    initGitRepo(join(outer, "packages", "inner"), { initialBranch: "main" })

    const exit = await configureAnd(WorkspaceService.listRepos())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.map((r) => r.name)).toStrictEqual(["outer"])
    }
  })

  it("ignores non-repo clutter like node_modules", async () => {
    initGitRepo(join(repos.dir, "app"), { initialBranch: "main" })
    mkdirSync(join(repos.dir, "node_modules", "some-pkg"), { recursive: true })

    const exit = await configureAnd(WorkspaceService.listRepos())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.map((r) => r.name)).toStrictEqual(["app"])
  })

  it("branches() returns the repo's branch names", async () => {
    const repoPath = initGitRepo(join(repos.dir, "multi"), {
      initialBranch: "main",
      branches: ["develop", "feat/scoring"]
    })
    const exit = await runExit(
      WorkspaceService.branches(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect([...exit.value].sort()).toStrictEqual(["develop", "feat/scoring", "main"])
    }
  })
})
