/**
 * `SecretStore` backed by Electron `safeStorage` — the OS credential vault
 * (macOS Keychain / Windows DPAPI / Linux libsecret). This is the most trusted
 * store available to an Electron app and is preferred over the unmaintained
 * `keytar`. Only ciphertext is ever written to `~/starbase/auth.enc`; if the OS
 * vault is unavailable we refuse to persist (forcing re-login) rather than fall
 * back to plaintext.
 */
import { FileSystem } from "@effect/platform"
import { AppPaths, SecretStore, SecretStoreUnavailable } from "@starbase/cli-adapters"
import { Effect, Layer } from "effect"
import { safeStorage } from "electron"

/**
 * A plaintext, file-backed `SecretStore` used ONLY by the e2e harness (selected
 * in `runtime.ts` via `STARBASE_SECRET_STORE=memory`). It sidesteps the OS
 * keychain — which would prompt / be unavailable under headless Playwright — so
 * the sign-in flow can be driven deterministically. NEVER used in a real build;
 * the production path is always `SecretStoreLive` below.
 */
export const PlaintextSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    return {
      get: fs
        .readFileString(paths.authFile)
        .pipe(
          Effect.map((raw) => (raw.trim().length > 0 ? raw.trim() : null)),
          Effect.orElseSucceed(() => null)
        ),
      set: (token: string) =>
        fs
          .writeFileString(paths.authFile, token)
          .pipe(Effect.mapError(() => new SecretStoreUnavailable({ message: "e2e write failed" }))),
      clear: fs.remove(paths.authFile).pipe(Effect.ignore)
    }
  })
)

export const SecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    return {
      get: Effect.gen(function* () {
        const exists = yield* fs.exists(paths.authFile).pipe(Effect.orElseSucceed(() => false))
        if (!exists || !safeStorage.isEncryptionAvailable()) return null
        const bytes = yield* fs.readFile(paths.authFile).pipe(Effect.orElseSucceed(() => null))
        if (!bytes) return null
        return yield* Effect.try(() =>
          safeStorage.decryptString(Buffer.from(bytes))
        ).pipe(Effect.orElseSucceed(() => null))
      }),
      set: (token: string) =>
        safeStorage.isEncryptionAvailable()
          ? fs
              .writeFile(paths.authFile, safeStorage.encryptString(token))
              .pipe(
                Effect.mapError(
                  () => new SecretStoreUnavailable({ message: "failed to write encrypted token" })
                )
              )
          : Effect.fail(
              new SecretStoreUnavailable({ message: "OS encryption is unavailable on this host" })
            ),
      clear: fs.remove(paths.authFile).pipe(Effect.ignore)
    }
  })
)
