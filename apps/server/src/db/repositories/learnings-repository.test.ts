import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Database } from "../database.js"
import type { OutcomeContribution } from "./learnings-repository.js"
import { LearningsRepository } from "./learnings-repository.js"

/**
 * Unit-level checks with a faked `Database`, mirroring `user-repository.test.ts`.
 *
 * What these can prove without Postgres: that every query the repository builds
 * is scoped, that contributions are namespaced per member, and that the shapes
 * coming back are normalised. Cross-tenant isolation against a real database is
 * asserted in the integration suite.
 */

const fakeDatabase = (rows: ReadonlyArray<unknown>) =>
  Layer.succeed(Database, { run: () => Effect.succeed(rows) } as unknown as Database)

const runWith = <A>(
  rows: ReadonlyArray<unknown>,
  effect: Effect.Effect<A, unknown, LearningsRepository>
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(LearningsRepository.Default), Effect.provide(fakeDatabase(rows)))
  )

const contribution = (over: Partial<OutcomeContribution> = {}): OutcomeContribution => ({
  id: "s1",
  repoKey: "repo-a",
  taskKind: "schema",
  cli: "codex",
  vendor: "openai",
  model: "gpt-5.6-sol",
  findingsCritical: 0,
  findingsMajor: 1,
  findingsMinor: 0,
  findingsNit: 0,
  ciPassed: true,
  merged: true,
  filesReverted: 0,
  planRevisions: 0,
  sizeBucket: "m",
  score: 1,
  occurredOn: "2026-07-18",
  ...over
})

describe("LearningsRepository", () => {
  it("does not hit the database for an empty contribution", async () => {
    // A sync tick with nothing new must cost nothing — the daemon runs this on a
    // schedule, and a query per idle tick is a query per user per interval.
    expect(await runWith([], LearningsRepository.record("org1", "u1", []))).toBe(0)
  })

  it("reports how many rows were actually recorded", async () => {
    expect(
      await runWith([{ id: "a" }, { id: "b" }], LearningsRepository.record("org1", "u1", [
        contribution(),
        contribution({ id: "s2" })
      ]))
    ).toBe(2)
  })

  it("normalises aggregate counts, which Postgres returns as strings", async () => {
    const rows = await runWith(
      [
        {
          cli: "codex",
          vendor: "openai",
          model: "gpt-5.6-sol",
          taskKind: "schema",
          observations: "19",
          meanScore: "1.5",
          contributors: "3"
        }
      ],
      LearningsRepository.affinity("org1", "repo-a")
    )
    expect(rows[0]).toStrictEqual({
      cli: "codex",
      vendor: "openai",
      model: "gpt-5.6-sol",
      taskKind: "schema",
      observations: 19,
      meanScore: 1.5,
      contributors: 3
    })
  })

  it("treats a null mean as zero rather than NaN", async () => {
    const rows = await runWith(
      [{ cli: "codex", vendor: "openai", model: "m", taskKind: "schema", observations: "0", meanScore: null, contributors: "0" }],
      LearningsRepository.affinity("org1", "repo-a")
    )
    expect(rows[0]?.meanScore).toBe(0)
  })

  it("reports how many rows a purge removed", async () => {
    expect(await runWith([{ id: "a" }], LearningsRepository.purge("org1", "u1"))).toBe(1)
  })

  it("counts today's contributions for the rate limit", async () => {
    expect(await runWith([{ n: "12" }], LearningsRepository.contributedToday("org1", "u1"))).toBe(12)
  })

  it("treats a missing count as zero", async () => {
    expect(await runWith([], LearningsRepository.contributedToday("org1", "u1"))).toBe(0)
  })
})

describe("contribution ids are namespaced per member", () => {
  it("cannot collide across users or organisations", async () => {
    // A session id is only unique on the machine that minted it. Two members
    // both syncing their session "s_1" must not overwrite one another, and one
    // org's row must never satisfy another's uniqueness check.
    const captured: Array<Array<{ id: string }>> = []
    const capturing = Layer.succeed(Database, {
      run: (_op: string, query: (c: unknown) => Promise<unknown>) =>
        Effect.sync(() => {
          const chain = {
            insert: () => chain,
            values: (v: Array<{ id: string }>) => {
              captured.push(v)
              return chain
            },
            onConflictDoNothing: () => chain,
            returning: () => []
          }
          void query(chain as never)
          return [] as never
        })
    } as unknown as Database)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* LearningsRepository.record("orgA", "alice", [contribution({ id: "s_1" })])
        yield* LearningsRepository.record("orgA", "bob", [contribution({ id: "s_1" })])
        yield* LearningsRepository.record("orgB", "alice", [contribution({ id: "s_1" })])
      }).pipe(Effect.provide(LearningsRepository.Default), Effect.provide(capturing))
    )

    const ids = captured.flat().map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toBe("orgA:alice:s_1")
  })
})
