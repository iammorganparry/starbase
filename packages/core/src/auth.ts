import { Schema } from "effect"

/**
 * Auth domain schemas, shared across the RPC boundary. The desktop app holds a
 * bearer token (in the OS keychain) issued by the `@starbase/server` BetterAuth
 * backend; these types describe what the renderer sees.
 */

/** OAuth providers offered on the sign-in wall (email magic link is separate). */
export const AuthProvider = Schema.Literal("github", "google")
export type AuthProvider = Schema.Schema.Type<typeof AuthProvider>

/** The authenticated user, projected from BetterAuth's `user` row. */
export const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  /** Display name — may be empty for magic-link users who never set one. */
  name: Schema.String,
  /** Avatar URL from the OAuth provider, or null. */
  image: Schema.NullOr(Schema.String)
})
export type User = Schema.Schema.Type<typeof User>

/** A live authenticated session: who, and until when. */
export const AuthSession = Schema.Struct({
  user: User,
  /** ISO-8601 expiry of the underlying BetterAuth session. */
  expiresAt: Schema.String
})
export type AuthSession = Schema.Schema.Type<typeof AuthSession>

/**
 * The renderer's auth state: a live session, or null when signed out. `getSession`
 * resolves to this (null also covers an expired/invalid token, which is cleared).
 */
export type AuthState = AuthSession | null

/**
 * An auth failure that crosses the RPC boundary (e.g. the magic-link request
 * failed, or the auth server is unreachable). `Schema.TaggedError` so it encodes
 * over IPC like the other RPC errors.
 */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String
}) {}
