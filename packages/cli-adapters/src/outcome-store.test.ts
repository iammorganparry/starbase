import type { Outcome } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { OutcomeStore } from "./outcome-store.js"
import { withTempRoot } from "./test-support.js"

/**
 * The corpus a repo's learnings are built from. What matters: appends survive a
 * torn write, a record from an older build doesn't destroy the file, and an
 * unwritable disk degrades to memory rather than turning the polling daemon into
 * a runaway that re-harvests forever. Real temp filesystem.
 */

let temp: ReturnType<typeof withTempRoot>
let runtime: ManagedRuntime.ManagedRuntime<
  OutcomeStore | FileSystem.FileSystem | Path.Path | AppPaths,
  never
>

beforeEach(() => {
  temp = withTempRoot()
  // ONE store instance per test, not one per call. The in-memory mirror is the
  // behaviour under test — rebuilding the layer for every `run` would hand each
  // call a fresh Ref and make the fallback tests silently vacuous.
  runtime = ManagedRuntime.make(Layer.mergeAll(OutcomeStore.Default, temp.layer))
})
afterEach(async () => {
  await runtime.dispose()
  temp.cleanup()
})

const run = <A>(
  effect: Effect.Effect<A, never, OutcomeStore | FileSystem.FileSystem | Path.Path | AppPaths>
) => runtime.runPromise(effect)

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  id: "s1",
  repoKey: "repo-a",
  taskKind: "schema",
  cli: "codex",
  vendor: "openai",
  model: "gpt-5.6-sol",
  signals: {
    findingsCritical: 0,
    findingsMajor: 1,
    findingsMinor: 0,
    findingsNit: 0,
    ciPassed: true,
    merged: true,
    filesReverted: 0,
    planRevisions: 0
  },
  sizeBucket: "m",
  confidence: "exact",
  score: 1,
  occurredOn: "2026-07-18",
  ...over
})

const outcomesFile = (repoKey: string) => join(temp.root, "outcomes", `${repoKey}.jsonl`)

describe("OutcomeStore", () => {
  it("is empty for a repo with no history", async () => {
    expect(await run(OutcomeStore.list("never-seen"))).toEqual([])
  })

  it("appends and reads back", async () => {
    await run(OutcomeStore.append(outcome()))
    await run(OutcomeStore.append(outcome({ id: "s2" })))
    expect((await run(OutcomeStore.list("repo-a"))).map((o) => o.id)).toEqual(["s1", "s2"])
  })

  it("appends one line per outcome rather than rewriting an array", async () => {
    // A read-modify-write over a growing corpus means a crash mid-write loses
    // the whole history to save one record.
    await run(OutcomeStore.append(outcome()))
    await run(OutcomeStore.append(outcome({ id: "s2" })))
    const lines = readFileSync(outcomesFile("repo-a"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).id).toBe("s1")
  })

  it("keeps repos apart", async () => {
    await run(OutcomeStore.append(outcome({ repoKey: "repo-a" })))
    await run(OutcomeStore.append(outcome({ repoKey: "repo-b", id: "s9" })))
    expect((await run(OutcomeStore.list("repo-a"))).map((o) => o.id)).toEqual(["s1"])
    expect((await run(OutcomeStore.list("repo-b"))).map((o) => o.id)).toEqual(["s9"])
  })

  it("skips an undecodable line instead of losing the file", async () => {
    // Losing one outcome is a rounding error; losing the file is losing the
    // repo's entire history.
    await run(OutcomeStore.append(outcome()))
    appendFileSync(outcomesFile("repo-a"), "{ written by an older build }\n")
    await run(OutcomeStore.append(outcome({ id: "s3" })))
    expect((await run(OutcomeStore.list("repo-a"))).map((o) => o.id)).toEqual(["s1", "s3"])
  })

  it("survives a torn final line", async () => {
    await run(OutcomeStore.append(outcome()))
    appendFileSync(outcomesFile("repo-a"), '{"id":"s2","repoKey":"repo-a"')
    expect((await run(OutcomeStore.list("repo-a"))).map((o) => o.id)).toEqual(["s1"])
  })

  it("falls back to memory when the file cannot be read", async () => {
    // ReviewStore's scar: reads that always miss turn the polling daemon into a
    // runaway that re-harvests and re-appends the same session every tick.
    await run(OutcomeStore.append(outcome()))
    mkdirSync(join(temp.root, "outcomes"), { recursive: true })
    writeFileSync(outcomesFile("repo-a"), "x")
    chmodSync(outcomesFile("repo-a"), 0o000)
    try {
      expect((await run(OutcomeStore.list("repo-a"))).map((o) => o.id)).toEqual(["s1"])
    } finally {
      chmodSync(outcomesFile("repo-a"), 0o644)
    }
  })

  it("does not throw when the outcomes directory cannot be created", async () => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "outcomes"), "not a directory")
    await expect(run(OutcomeStore.append(outcome()))).resolves.toBeUndefined()
  })

  it("still reports the outcome from memory after an unwritable append", async () => {
    // The de-dupe must not depend on a write that can fail.
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "outcomes"), "not a directory")
    await run(OutcomeStore.append(outcome()))
    expect(await run(OutcomeStore.harvested("repo-a"))).toEqual(new Set(["s1"]))
  })

  it("reports harvested ids so the daemon does not re-harvest", async () => {
    await run(OutcomeStore.append(outcome()))
    await run(OutcomeStore.append(outcome({ id: "s2" })))
    expect(await run(OutcomeStore.harvested("repo-a"))).toEqual(new Set(["s1", "s2"]))
  })

  it("clears a repo's corpus", async () => {
    await run(OutcomeStore.append(outcome()))
    await run(OutcomeStore.clear("repo-a"))
    expect(await run(OutcomeStore.list("repo-a"))).toEqual([])
  })

  it("lists every repo with recorded outcomes", async () => {
    await run(OutcomeStore.append(outcome({ repoKey: "repo-a" })))
    await run(OutcomeStore.append(outcome({ repoKey: "repo-b" })))
    expect(await run(OutcomeStore.repos())).toEqual(["repo-a", "repo-b"])
  })
})
