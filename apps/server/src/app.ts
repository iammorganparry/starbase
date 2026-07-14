/**
 * The framework-agnostic Hono app — the single source of truth for both the
 * local dev server (`src/index.ts` via `@hono/node-server`) and the Vercel
 * function (`api/[[...route]].ts` via `@hono/vercel`). Keeping the app here (and
 * the runtimes thin) means the exact same routing runs in both places.
 */
import { Effect, Option } from "effect"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth.js"
import { UserRepository } from "./db/repositories/user-repository.js"
import { env } from "./env.js"
import { runtime } from "./runtime.js"

export const app = new Hono()

// The desktop app calls the auth API from a `starbase://` origin (and the Vite
// dev renderer from localhost). Allow credentials so BetterAuth cookies/bearer
// round-trip.
app.use(
  "/api/*",
  cors({
    origin: ["starbase://", "http://localhost:5173", "http://localhost:9100"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true
  })
)

/** Liveness probe (Vercel + local + e2e all hit this). */
app.get("/health", (c) => c.json({ status: "ok", service: "@starbase/server" }))

/** BetterAuth owns everything under /api/auth/* (OAuth, magic link, session). */
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

/**
 * The signed-in user's profile. BetterAuth validates the bearer session; the user
 * row is then loaded through `UserRepository` (via the Effect runtime) — the
 * canonical shape for any DB-backed endpoint we add (billing, usage, …).
 */
app.get("/api/me", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401)
  const user = await runtime
    .runPromise(UserRepository.findById(session.user.id).pipe(Effect.map(Option.getOrNull)))
    .catch(() => null)
  if (!user) return c.json({ error: "Not found" }, 404)
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image }
  })
})

/**
 * Desktop bridge. OAuth and magic-link flows complete in the user's browser,
 * where the session is a cookie the desktop app can't read. The client sets THIS
 * route as its `callbackURL`; here we read the freshly-created session server-
 * side and 302 to the `starbase://` deep link carrying the bearer token, which
 * the desktop then stores in the OS keychain. On failure we bounce back with an
 * `error` param so the LoginScreen can show its error state.
 */
app.get("/desktop/callback", async (c) => {
  const session = await auth.api
    .getSession({ headers: c.req.raw.headers })
    .catch(() => null)
  if (!session?.session?.token) {
    return c.redirect(`${env.desktopRedirect}?error=nosession`)
  }
  const token = encodeURIComponent(session.session.token)
  return c.redirect(`${env.desktopRedirect}?token=${token}`)
})

export default app
