/**
 * A secret store for the signed-in session token. The tag lives here (so
 * `AuthService` can depend on it and tests can supply a fake), while the real
 * implementation — Electron `safeStorage`, the OS credential vault — is provided
 * by the main process (`apps/desktop/src/main/secret-store.ts`), keeping
 * `cli-adapters` free of any `electron` import.
 *
 * Security contract: `set` NEVER writes plaintext. If the OS vault is
 * unavailable it fails with `SecretStoreUnavailable` rather than degrade, so a
 * missing keychain forces re-login instead of leaking a bearer token to disk.
 */
import { Context, Data, Effect, Layer, Ref } from "effect"

export class SecretStoreUnavailable extends Data.TaggedError("SecretStoreUnavailable")<{
  readonly message: string
}> {}

export interface SecretStoreShape {
  /** The stored token, or null when signed out / unavailable. Never fails. */
  readonly get: Effect.Effect<string | null>
  /** Persist the token as ciphertext. Fails if the OS vault is unavailable. */
  readonly set: (token: string) => Effect.Effect<void, SecretStoreUnavailable>
  /** Remove the stored token (idempotent). */
  readonly clear: Effect.Effect<void>
}

export class SecretStore extends Context.Tag("@starbase/SecretStore")<
  SecretStore,
  SecretStoreShape
>() {}

/** Build an in-memory store (tests + the e2e harness seed a starting token). */
export const makeInMemorySecretStore = (
  initial: string | null = null
): Effect.Effect<SecretStoreShape> =>
  Effect.map(Ref.make<string | null>(initial), (ref) => ({
    get: Ref.get(ref),
    set: (token: string) => Ref.set(ref, token),
    clear: Ref.set(ref, null)
  }))

/** An in-memory `SecretStore` layer, signed out by default. */
export const InMemorySecretStoreLive = Layer.effect(SecretStore, makeInMemorySecretStore())
