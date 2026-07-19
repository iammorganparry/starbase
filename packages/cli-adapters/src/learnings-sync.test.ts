import type { Outcome, WorkspaceConfig } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer, ManagedRuntime, Schedule } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppPaths } from "./app-paths.js"
import { contribute, pendingFor, readCursor, sharingEnabled } from "./learnings-sync.js"
import { SecretStore } from "./secret-store.js"
import { withTempRoot } from "./test-support.js"

/** No real sleeping in tests — same shape as the default, none of the wall time. */
const FAST_RETRY = Schedule.recurs(3)

/**
 * Sharing must be lossless and silent. What matters: nothing leaves the machine
 * unless BOTH switches are on, a failed request loses no outcome, a dead token
 * stops the sweep instead of being retried forever, and an ambiguous attribution
 * never reaches a corpus a teammate will read.
 */

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  id: "s1",
  repoKey: "repo-a",
  taskKind: "schema",
  cli: "codex",
  vendor: "openai",
  model: "gpt-5.6-sol",
  signals: {
    findingsCritical: 0,
    findingsMajor: 0,
    findingsMinor: 0,
    findingsNit: 0,
    ciPassed: true,
    merged: true,
    filesReverted: 0,
    planRevisions: 0
  },
  sizeBucket: "m",
  confidence: "exact",
  score: 2,
  occurredOn: "2026-07-18",
  ...over
})

const config = (over: Partial<NonNullable<WorkspaceConfig["learning"]>> = {}): WorkspaceConfig => ({
  reposDir: "/repos",
  createdAt: "2026-01-01T00:00:00.000Z",
  learning: { enabled: true, ...over }
})

describe("sharingEnabled — fail closed", () => {
  it("requires BOTH switches", () => {
    // A stale `sharing: true` must not keep sending after the operator switched
    // learning off — the same gate the repo already applies to auto-review.
    expect(sharingEnabled(config({ sharing: true }))).toBe(true)
    expect(sharingEnabled(config({ sharing: false }))).toBe(false)
    expect(sharingEnabled(config())).toBe(false)
    expect(sharingEnabled({ ...config({ sharing: true }), learning: { enabled: false, sharing: true } })).toBe(false)
    expect(sharingEnabled(null)).toBe(false)
  })
})

describe("pendingFor", () => {
  it("never sends an ambiguous attribution", () => {
    // A local cell can afford a discounted guess; a SHARED one cannot, because a
    // teammate reading it has no way to know the evidence was fuzzy.
    const out = pendingFor([outcome({ confidence: "ambiguous" }), outcome({ id: "s2" })], new Set())
    expect(out.map((o) => o.id)).toEqual(["s2"])
  })

  it("skips what has already been contributed", () => {
    const out = pendingFor([outcome({ id: "s1" }), outcome({ id: "s2" })], new Set(["s1"]))
    expect(out.map((o) => o.id)).toEqual(["s2"])
  })
})

describe("contribute", () => {
  let temp: ReturnType<typeof withTempRoot>
  let runtime: ManagedRuntime.ManagedRuntime<
    FileSystem.FileSystem | Path.Path | AppPaths | SecretStore,
    never
  >
  const fetchMock = vi.fn()

  const secrets = (token: string | null) =>
    Layer.succeed(SecretStore, {
      get: Effect.succeed(token),
      set: () => Effect.void,
      clear: Effect.void
    })

  const boot = (token: string | null = "tok") => {
    temp = withTempRoot()
    runtime = ManagedRuntime.make(Layer.mergeAll(temp.layer, secrets(token)))
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    boot()
  })
  afterEach(async () => {
    await runtime.dispose()
    temp.cleanup()
    vi.unstubAllGlobals()
  })

  it("sends eligible outcomes and records them as sent", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    const result = await runtime.runPromise(contribute("repo-a", [outcome(), outcome({ id: "s2" })], FAST_RETRY))
    expect(result).toStrictEqual({ sent: 2, unauthorized: false })
    expect(await runtime.runPromise(readCursor("repo-a"))).toEqual(new Set(["s1", "s2"]))
  })

  it("sends the bearer token", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await runtime.runPromise(contribute("repo-a", [outcome()], FAST_RETRY))
    const headers = fetchMock.mock.calls[0]?.[1]?.headers
    expect(headers.Authorization).toBe("Bearer tok")
  })

  it("sends NOTHING when there is nothing eligible", async () => {
    await runtime.runPromise(contribute("repo-a", [outcome({ confidence: "ambiguous" })], FAST_RETRY))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("loses no outcome when the server is unreachable", async () => {
    // The cursor is only advanced after a confirmed 2xx, so a failure leaves the
    // outcome queued rather than silently dropping it.
    fetchMock.mockRejectedValue(new Error("offline"))
    const result = await runtime.runPromise(contribute("repo-a", [outcome()], FAST_RETRY))
    expect(result.sent).toBe(0)
    expect(await runtime.runPromise(readCursor("repo-a"))).toEqual(new Set())
  })

  it("retries a transient failure, then gives up quietly", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const result = await runtime.runPromise(contribute("repo-a", [outcome()], FAST_RETRY))
    expect(result.sent).toBe(0)
    // Retried, but a bounded number of times — the daemon comes round again in
    // minutes, so hammering a struggling server inside one tick buys nothing.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it("does NOT retry a rejected token", async () => {
    // It would be rejected identically three more times, then once per repo,
    // then again every tick.
    fetchMock.mockResolvedValue({ ok: false, status: 401 })
    const result = await runtime.runPromise(contribute("repo-a", [outcome()], FAST_RETRY))
    expect(result).toStrictEqual({ sent: 0, unauthorized: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports unauthorized without calling out when signed out", async () => {
    await runtime.dispose()
    boot(null)
    const result = await runtime.runPromise(contribute("repo-a", [outcome()], FAST_RETRY))
    expect(result.unauthorized).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not re-send on a second pass", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    const outcomes = [outcome()]
    await runtime.runPromise(contribute("repo-a", outcomes, FAST_RETRY))
    fetchMock.mockClear()
    const again = await runtime.runPromise(contribute("repo-a", outcomes, FAST_RETRY))
    expect(again.sent).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends only the closed wire shape, never the whole outcome", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await runtime.runPromise(contribute("repo-a", [outcome()], FAST_RETRY))
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
    // `confidence` is a local judgement about our own attribution and has no
    // meaning to a teammate; it must not travel.
    expect(body.outcomes[0]).not.toHaveProperty("confidence")
    expect(body.outcomes[0]).not.toHaveProperty("signals")
    expect(body.outcomes[0].findingsMajor).toBe(0)
  })
})
