import { join } from "node:path"
import type { CreateSessionInput } from "@starbase/core"
import { fallbackTitle, userMessage } from "@starbase/core"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GitService } from "./git.js"
import { retitleSession, type TitleGenerator } from "./session-title-service.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { failureOf, initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * `retitleSession` is the orchestration seam: it reads the transcript, asks a
 * pluggable generator for a title, persists it, and returns the fresh record —
 * skipping pinned sessions. We inject deterministic generators (no real LLM) and
 * assert persistence, the heuristic-fallback path, and the pin.
 */
describe("retitleSession", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  let repoPath: string
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("starbase-repos-")
    repoPath = initGitRepo(join(repos.dir, "app"))
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const services = Layer.mergeAll(
  SessionStore.Default,
  TranscriptStore.Default,
  GitService.Default
)
  const input = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
    repoPath,
    repoName: "app",
    cli: "claude",
    baseBranch: "main",
    ...over
  })
  const fixed = (title: string): TitleGenerator => ({ generate: () => Effect.succeed(title) })

  it("generates, persists, and returns the updated title for an auto-titled session", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input())
        yield* TranscriptStore.append(s.id, userMessage("u1", "help me add caching", "2026-07-13T00:00:00.000Z"))
        const updated = yield* retitleSession(s.id, fixed("Add response caching"))
        const persisted = yield* SessionStore.get(s.id)
        return { updated, persisted }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.updated.title).toBe("Add response caching")
    expect(exit.value.persisted.title).toBe("Add response caching")
  })

  it("falls back to the first user message when the generator yields the heuristic", async () => {
    const fallbackGen: TitleGenerator = { generate: (messages) => Effect.succeed(fallbackTitle(messages)) }
    const exit = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input())
        yield* TranscriptStore.append(s.id, userMessage("u1", "Refactor the auth middleware", "2026-07-13T00:00:00.000Z"))
        return yield* retitleSession(s.id, fallbackGen)
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.title).toBe("Refactor the auth middleware")
  })

  it("skips a pinned session (autoTitle false) — the generator is never called", async () => {
    let called = false
    const spyGen: TitleGenerator = {
      generate: () =>
        Effect.sync(() => {
          called = true
          return "SHOULD NOT APPEAR"
        })
    }
    const exit = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input())
        yield* SessionStore.renameTitle(s.id, "Pinned name") // sets autoTitle false
        return yield* retitleSession(s.id, spyGen)
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.title).toBe("Pinned name")
    expect(called).toBe(false)
  })

  it("fails with GitError for an unknown session id", async () => {
    const exit = await runExit(
      retitleSession("nope", fixed("x")).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("GitError")
  })
})
