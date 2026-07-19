import type { Session, WorkspaceConfig } from "@starbase/core"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ConfigService } from "./config.js"
import { harvest, tick } from "./learning-daemon.js"
import { SessionStore } from "./sessions.js"

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  repo: "api",
  branch: "starbase/x",
  title: "Add a tier column",
  status: "idle",
  cli: "codex",
  diff: { added: 120, removed: 30 },
  prNumber: 42,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T10:00:00.000Z",
  worktreePath: "/w",
  model: "gpt-5.6-sol",
  ...over
})

const step = (taskKind: string | undefined, ...paths: ReadonlyArray<string>) =>
  ({ taskKind, files: paths.map((path) => ({ path })) }) as never

const input = (over: Partial<Parameters<typeof harvest>[0]> = {}) => ({
  session: session(),
  repoKey: "repo-a",
  steps: [step("schema", "db/schema.sql")],
  findings: [],
  ciPassed: null,
  filesReverted: 0,
  planRevisions: 0,
  linesChanged: 150,
  occurredOn: "2026-07-18",
  ...over
})

describe("harvest — what it declines to record", () => {
  it("declines when no step declared a task kind", () => {
    // Guessing a kind from file extensions would manufacture a taxonomy the
    // operator never agreed to, and a wrong kind teaches the wrong cell — worse
    // than no outcome at all.
    expect(harvest(input({ steps: [step(undefined, "src/a.ts")] }))).toBeNull()
  })

  it("declines when the session has no resolvable model", () => {
    expect(harvest(input({ session: session({ model: undefined }) }))).toBeNull()
  })

  it("declines for a harness with no real adapter", () => {
    // cursor falls through to the scripted stub, so its "outcome" would be about
    // fabricated work.
    expect(harvest(input({ session: session({ cli: "cursor", model: "auto" }) }))).toBeNull()
  })
})

describe("harvest — what it records", () => {
  it("files the outcome under the declared task kind and resolved vendor", () => {
    const o = harvest(input())!
    expect(o.taskKind).toBe("schema")
    expect(o.vendor).toBe("openai")
    expect(o.model).toBe("gpt-5.6-sol")
    // The session id IS the outcome id — that is the daemon's de-dupe key.
    expect(o.id).toBe("s1")
  })

  it("takes the most common declared kind when steps disagree", () => {
    const o = harvest(
      input({ steps: [step("schema", "a"), step("backend", "b"), step("backend", "c")] })
    )!
    expect(o.taskKind).toBe("backend")
  })

  it("counts findings by severity", () => {
    const o = harvest(
      input({
        findings: [
          { path: "db/schema.sql", severity: "critical" },
          { path: "db/schema.sql", severity: "minor" },
          { path: null, severity: "minor" }
        ]
      })
    )!
    expect(o.signals.findingsCritical).toBe(1)
    expect(o.signals.findingsMinor).toBe(2)
    expect(o.score).toBeLessThan(0)
  })

  it("marks attribution ambiguous when two steps claim the file", () => {
    const o = harvest(
      input({
        steps: [step("schema", "db/schema.sql"), step("schema", "db/schema.sql")],
        findings: [{ path: "db/schema.sql", severity: "major" }]
      })
    )!
    expect(o.confidence).toBe("ambiguous")
  })

  it("stays exact when one step owns the file", () => {
    const o = harvest(input({ findings: [{ path: "db/schema.sql", severity: "major" }] }))!
    expect(o.confidence).toBe("exact")
  })

  it("keeps 'still open' distinct from 'closed unmerged'", () => {
    expect(harvest(input())!.signals.merged).toBeNull()
    expect(
      harvest(input({ session: session({ archived: true, archiveReason: "merged" }) }))!.signals
        .merged
    ).toBe(true)
    expect(
      harvest(input({ session: session({ archived: true, archiveReason: "closed" }) }))!.signals
        .merged
    ).toBe(false)
  })

  it("buckets the size rather than recording the line count", () => {
    // Raw counts near-uniquely fingerprint a change.
    const o = harvest(input({ linesChanged: 150 }))!
    expect(o.sizeBucket).toBe("m")
    expect(JSON.stringify(o)).not.toContain("150")
  })

  it("records day precision only", () => {
    expect(harvest(input())!.occurredOn).toBe("2026-07-18")
  })

  it("carries no free text anywhere, even for a richly-titled session", () => {
    // The session title is operator prose; it must not ride along.
    const o = harvest(input({ session: session({ title: "Migrate the Acme billing export" }) }))!
    expect(JSON.stringify(o)).not.toMatch(/Acme|billing|export/)
  })
})


/**
 * The tick's two hard guards. Both are asserted by making the stores THROW if
 * they are touched: a test that merely checks "no outcome was written" would
 * still pass if the daemon read the operator's whole session list first, which
 * is exactly what "off" must not mean.
 */
const exploding = <T,>(tag: T) =>
  Layer.succeed(tag as never, new Proxy({}, {
    get: () => () => {
      throw new Error("the daemon touched a store it should not have")
    }
  }) as never)

const configLayer = (config: WorkspaceConfig | null) =>
  Layer.succeed(ConfigService, {
    get: () => Effect.succeed(config)
  } as unknown as ConfigService)

const baseConfig = (learning?: { enabled: boolean }): WorkspaceConfig => ({
  reposDir: "/repos",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(learning ? { learning } : {})
})

const runTick = (config: WorkspaceConfig | null, busy = false) =>
  Effect.runPromise(
    tick(() => busy).pipe(
      Effect.provide(configLayer(config)),
      Effect.provide(exploding(SessionStore))
    ) as Effect.Effect<number, never, never>
  )

describe("tick — inert unless enabled", () => {
  it("reads NOTHING when learning is off", async () => {
    // Not "collects quietly and withholds" — off means the daemon does not run.
    await expect(runTick(baseConfig({ enabled: false }))).resolves.toBe(0)
  })

  it("reads nothing when the section is absent (older config)", async () => {
    await expect(runTick(baseConfig())).resolves.toBe(0)
  })

  it("reads nothing when there is no config at all", async () => {
    await expect(runTick(null)).resolves.toBe(0)
  })

  it("stands down while a session is running, even when enabled", async () => {
    // A tick that ran here would contend for the rate limits the operator is
    // actively waiting on.
    await expect(runTick(baseConfig({ enabled: true }), true)).resolves.toBe(0)
  })

  it("DOES reach the store once enabled and idle", async () => {
    // The counter-test, and it is essential: without it every assertion above
    // would pass on a daemon that never does anything at all. The exploding
    // store is what makes "touched it" observable, so reaching it must reject.
    await expect(runTick(baseConfig({ enabled: true }), false)).rejects.toThrow(
      /touched a store/
    )
  })
})
