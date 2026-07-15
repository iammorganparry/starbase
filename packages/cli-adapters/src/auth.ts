/**
 * The desktop-side auth seam. `AuthService` mediates between the OS keychain
 * (`SecretStore`, holding the bearer token) and the `@starbase/server` BetterAuth
 * backend. The renderer drives it through the `Auth.*` RPCs:
 *   - `getSession` — validate the stored token against the server (clearing it if
 *     invalid/expired), returning the user or null.
 *   - `startSignIn` — ask the server for the provider's OAuth URL (the renderer
 *     opens it in the system browser; the flow returns via the `starbase://`
 *     deep link handled in the main process).
 *   - `sendMagicLink` — request an email magic link.
 *   - `signOut` — revoke on the server (best effort) and clear the local token.
 *
 * The token is never logged and only ever read from / written to `SecretStore`.
 */
import type { AuthProvider, AuthSession } from "@starbase/core"
import { AuthError } from "@starbase/core"
import { Effect } from "effect"
import { SecretStore } from "./secret-store.js"

/** Base URL of the auth backend. Overridable (prod deploy, e2e fake server). */
const authBaseUrl = (): string => process.env.STARBASE_AUTH_URL ?? "http://localhost:9100"

/** Where the browser flow bounces back to before redirecting to `starbase://`. */
const desktopCallback = (base: string): string => `${base}/desktop/callback`

interface SessionResponse {
  readonly session?: { readonly expiresAt?: string } | null
  readonly user?:
    | { readonly id: string; readonly email: string; readonly name?: string; readonly image?: string | null }
    | null
}

export class AuthService extends Effect.Service<AuthService>()("@starbase/AuthService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const secrets = yield* SecretStore

    /** Validate the stored token; null when signed out, invalid, or unreachable. */
    const getSession = (): Effect.Effect<AuthSession | null> =>
      Effect.gen(function* () {
        const token = yield* secrets.get
        if (!token) return null
        const base = authBaseUrl()
        const res = yield* Effect.tryPromise(() =>
          fetch(`${base}/api/auth/get-session`, {
            headers: { Authorization: `Bearer ${token}` }
          })
        ).pipe(Effect.orElseSucceed(() => null))
        // Network error → keep the token, stay signed out for now (transient).
        if (!res) return null
        // Unauthorized → the token is dead; clear it so we stop retrying.
        if (res.status === 401) {
          yield* secrets.clear
          return null
        }
        if (!res.ok) return null
        const body = yield* Effect.tryPromise(() => res.json() as Promise<SessionResponse>).pipe(
          Effect.orElseSucceed(() => null)
        )
        if (!body?.session || !body.user) {
          yield* secrets.clear
          return null
        }
        return {
          user: {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name ?? "",
            image: body.user.image ?? null
          },
          expiresAt: body.session.expiresAt ?? ""
        }
      })

    /** POST to the auth server, mapping any failure to a user-facing `AuthError`. */
    const post = (path: string, payload: unknown): Effect.Effect<Response, AuthError> =>
      Effect.tryPromise({
        try: () =>
          fetch(`${authBaseUrl()}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }),
        catch: () => new AuthError({ message: "Couldn't reach the sign-in service." })
      }).pipe(
        Effect.filterOrFail(
          (res) => res.ok,
          () => new AuthError({ message: "The sign-in service rejected the request." })
        )
      )

    /** Get the provider OAuth URL to open in the system browser. */
    const startSignIn = (provider: AuthProvider): Effect.Effect<string, AuthError> =>
      Effect.gen(function* () {
        const res = yield* post("/api/auth/sign-in/social", {
          provider,
          callbackURL: desktopCallback(authBaseUrl())
        })
        const body = yield* Effect.tryPromise({
          try: () => res.json() as Promise<{ url?: string }>,
          catch: () => new AuthError({ message: "Unexpected sign-in response." })
        })
        if (!body.url) return yield* Effect.fail(new AuthError({ message: "No sign-in URL returned." }))
        return body.url
      })

    /**
     * Request a magic-link email. `name` is passed through only for sign-up (the
     * server applies it as the display name when creating a new user; BetterAuth
     * ignores it for existing accounts).
     */
    const sendMagicLink = (email: string, name?: string): Effect.Effect<void, AuthError> =>
      post("/api/auth/sign-in/magic-link", {
        email,
        ...(name ? { name } : {}),
        callbackURL: desktopCallback(authBaseUrl())
      }).pipe(Effect.asVoid)

    /** Revoke on the server (best effort) and always clear the local token. */
    const signOut = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const token = yield* secrets.get
        if (token) {
          yield* Effect.tryPromise(() =>
            fetch(`${authBaseUrl()}/api/auth/sign-out`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` }
            })
          ).pipe(Effect.ignore)
        }
        yield* secrets.clear
      })

    return { getSession, startSignIn, sendMagicLink, signOut } as const
  })
}) {}
