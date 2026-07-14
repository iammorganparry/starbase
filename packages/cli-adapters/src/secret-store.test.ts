import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeInMemorySecretStore } from "./secret-store.js"

/**
 * The in-memory `SecretStore` (used by tests + the e2e harness). We assert the
 * round-trip contract the real keychain store must also honour: get→null when
 * empty, set→get, and clear→null.
 */
describe("SecretStore (in-memory)", () => {
  it("returns null before anything is stored", async () => {
    const value = await Effect.runPromise(
      Effect.flatMap(makeInMemorySecretStore(), (store) => store.get)
    )
    expect(value).toBeNull()
  })

  it("round-trips a token through set → get", async () => {
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemorySecretStore()
        yield* store.set("tok_123")
        return yield* store.get
      })
    )
    expect(value).toBe("tok_123")
  })

  it("clears the stored token", async () => {
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemorySecretStore("tok_123")
        yield* store.clear
        return yield* store.get
      })
    )
    expect(value).toBeNull()
  })

  it("seeds an initial token (e2e signed-in fixture)", async () => {
    const value = await Effect.runPromise(
      Effect.flatMap(makeInMemorySecretStore("seed"), (store) => store.get)
    )
    expect(value).toBe("seed")
  })
})
