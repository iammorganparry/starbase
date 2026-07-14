import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { Database } from "../database.js"
import { UserRepository } from "./user-repository.js"

/**
 * `UserRepository` is exercised against a FAKE `Database` — `run` ignores the
 * Drizzle query and returns canned rows — so we test the repository's mapping and
 * Option handling (and the DI seam) without a live Postgres, keeping this CI-safe.
 * The real query execution is covered by the (local, DB-backed) integration pass.
 */
const row = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  image: null,
  emailVerified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0)
}

/** A Database layer whose `run` always resolves to `rows`, ignoring the query. */
const fakeDatabase = (rows: ReadonlyArray<unknown>) =>
  Layer.succeed(Database, {
    run: () => Effect.succeed(rows)
  } as unknown as Database)

const runWith = <A>(rows: ReadonlyArray<unknown>, effect: Effect.Effect<A, unknown, UserRepository>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(UserRepository.Default), Effect.provide(fakeDatabase(rows)))
  )

describe("UserRepository", () => {
  it("findById returns Some(record) mapped from the row", async () => {
    const result = await runWith([row], UserRepository.findById("u1"))
    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)?.email).toBe("ada@example.com")
  })

  it("findById returns None when no row matches", async () => {
    const result = await runWith([], UserRepository.findById("missing"))
    expect(Option.isNone(result)).toBe(true)
  })

  it("findByEmail maps the row", async () => {
    const result = await runWith([row], UserRepository.findByEmail("ada@example.com"))
    expect(Option.getOrNull(result)?.id).toBe("u1")
  })

  it("list maps every row", async () => {
    const result = await runWith([row, { ...row, id: "u2", email: "grace@example.com" }], UserRepository.list())
    expect(result.map((u) => u.id)).toEqual(["u1", "u2"])
  })
})
