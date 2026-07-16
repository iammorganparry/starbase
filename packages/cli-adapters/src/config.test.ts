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

  it("persists github prefs and preserves the repos dir + createdAt", async () => {
    const github = { enabled: true, autoCreatePr: false, autoDetectPr: true }
    const exit = await provided(
      Effect.gen(function* () {
        const first = yield* ConfigService.setReposDir("/repos/a")
        yield* ConfigService.setGithub(github)
        // A later setReposDir must keep the github prefs.
        yield* ConfigService.setReposDir("/repos/b")
        const final = yield* ConfigService.get()
        return { first, final }
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.final?.github).toStrictEqual(github)
      expect(exit.value.final?.reposDir).toBe("/repos/b")
      expect(exit.value.final?.createdAt).toBe(exit.value.first.createdAt)
    }
  })

  it("decodes a config written without a github field (backward compatible)", async () => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(`${temp.root}/config.json`, JSON.stringify({ reposDir: "/x", createdAt: "2026-01-01" }))
    const exit = await provided(ConfigService.get())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value?.reposDir).toBe("/x")
      expect(exit.value?.github).toBeUndefined()
    }
  })

  it("setGit persists the git lever and preserves reposDir + github", async () => {
    const github = { enabled: true, autoCreatePr: false, autoDetectPr: true }
    const git = { shareCheckedOutBranches: true }
    const exit = await provided(
      Effect.gen(function* () {
        yield* ConfigService.setReposDir("/repos/a")
        yield* ConfigService.setGithub(github)
        yield* ConfigService.setGit(git)
        // A later setGithub must keep the git prefs, and vice-versa.
        yield* ConfigService.setGithub({ ...github, autoCreatePr: true })
        return yield* ConfigService.get()
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value?.git).toStrictEqual(git)
      expect(exit.value?.github?.autoCreatePr).toBe(true)
      expect(exit.value?.reposDir).toBe("/repos/a")
    }
  })

  it("setCollapsedRepos persists the list and preserves reposDir + starredRepos", async () => {
    const exit = await provided(
      Effect.gen(function* () {
        yield* ConfigService.setReposDir("/repos/a")
        yield* ConfigService.setStarredRepos(["/repos/a/one"])
        yield* ConfigService.setCollapsedRepos(["/repos/a/two", "__archived__"])
        return yield* ConfigService.get()
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value?.collapsedRepos).toStrictEqual(["/repos/a/two", "__archived__"])
      expect(exit.value?.starredRepos).toStrictEqual(["/repos/a/one"])
      expect(exit.value?.reposDir).toBe("/repos/a")
    }
  })

  it("setProvider upserts one CLI's defaults and preserves the other providers + sections", async () => {
    const github = { enabled: true, autoCreatePr: false, autoDetectPr: true }
    const claude = { enabled: true, defaultMode: "plan", defaultModel: "opus" } as const
    const codex = { enabled: false, defaultMode: "accept-edits" } as const
    const exit = await provided(
      Effect.gen(function* () {
        yield* ConfigService.setReposDir("/repos/a")
        yield* ConfigService.setGithub(github)
        yield* ConfigService.setProvider("claude", claude)
        // Upserting codex must keep claude; a later setGithub must keep both.
        yield* ConfigService.setProvider("codex", codex)
        yield* ConfigService.setGithub({ ...github, autoCreatePr: true })
        return yield* ConfigService.get()
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value?.providers?.claude).toStrictEqual(claude)
      expect(exit.value?.providers?.codex).toStrictEqual(codex)
      expect(exit.value?.github?.autoCreatePr).toBe(true)
      expect(exit.value?.reposDir).toBe("/repos/a")
    }
  })

  it("setProvider replaces an existing provider entry in place", async () => {
    const exit = await provided(
      Effect.gen(function* () {
        yield* ConfigService.setProvider("claude", { enabled: true, defaultMode: "ask" })
        yield* ConfigService.setProvider("claude", {
          enabled: true,
          defaultMode: "auto",
          defaultModel: "sonnet"
        })
        return yield* ConfigService.get()
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value?.providers?.claude).toStrictEqual({
        enabled: true,
        defaultMode: "auto",
        defaultModel: "sonnet"
      })
    }
  })

  it("decodes a config written without a providers field (backward compatible)", async () => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(`${temp.root}/config.json`, JSON.stringify({ reposDir: "/x", createdAt: "2026-01-01" }))
    const exit = await provided(ConfigService.get())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value?.reposDir).toBe("/x")
      expect(exit.value?.providers).toBeUndefined()
    }
  })
})
