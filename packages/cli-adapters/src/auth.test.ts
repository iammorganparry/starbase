import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthService } from "./auth.js"
import { makeInMemorySecretStore, SecretStore } from "./secret-store.js"

/**
 * `AuthService` bridges the keychain (`SecretStore`) and the BetterAuth backend.
 * We stub `fetch` and provide an in-memory store to assert the outcomes the wall
 * depends on: no token → signed out (no network), a dead token is cleared, and a
 * valid token yields the user.
 */

const withStore = (token: string | null) =>
  Layer.effect(SecretStore, makeInMemorySecretStore(token))

const runGetSession = (token: string | null) =>
  Effect.runPromise(
    AuthService.getSession().pipe(Effect.provide(AuthService.Default), Effect.provide(withStore(token)))
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AuthService.getSession", () => {
  it("returns null and never hits the network when signed out", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const session = await runGetSession(null)
    expect(session).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the user for a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            session: { expiresAt: "2099-01-01T00:00:00Z" },
            user: { id: "u1", email: "a@b.com", name: "Ada", image: null }
          }),
          { status: 200 }
        )
      )
    )
    const session = await runGetSession("tok_valid")
    expect(session?.user.email).toBe("a@b.com")
    expect(session?.user.name).toBe("Ada")
  })

  it("clears a dead token (401) and returns null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })))
    // Use a shared store so we can observe it was cleared.
    const store = await Effect.runPromise(makeInMemorySecretStore("tok_dead"))
    const layer = Layer.succeed(SecretStore, store)
    const session = await Effect.runPromise(
      AuthService.getSession().pipe(Effect.provide(AuthService.Default), Effect.provide(layer))
    )
    expect(session).toBeNull()
    const remaining = await Effect.runPromise(store.get)
    expect(remaining).toBeNull()
  })
})
