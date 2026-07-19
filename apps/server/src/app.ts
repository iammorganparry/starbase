/**
 * The framework-agnostic Hono app — the single source of truth for both the
 * local dev server (`src/index.ts` via `@hono/node-server`) and the Vercel
 * function (`api/[[...route]].ts` via `@hono/vercel`). Keeping the app here (and
 * the runtimes thin) means the exact same routing runs in both places.
 */
import { Effect, Option, Schema } from "effect"
import { LearningsRepository } from "./db/repositories/learnings-repository.js"
import { canShareLearnings } from "./entitlements.js"
import { CliKind, SizeBucket, TaskKind } from "@starbase/core"
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
/**
 * What a contribution may contain.
 *
 * Every field is a closed literal or a number — there is no free-text field, by
 * construction, mirroring the desktop's `Outcome`. Validating here rather than
 * trusting the client means a future client bug cannot smuggle prose into a
 * shared corpus, and `Schema` is used rather than a hand-rolled check because
 * `effect` is already a dependency and hand-rolled validators drift.
 */
const ContributionPayload = Schema.Struct({
  outcomes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      repoKey: Schema.String,
      taskKind: TaskKind,
      cli: CliKind,
      vendor: Schema.String,
      model: Schema.String,
      findingsCritical: Schema.Number,
      findingsMajor: Schema.Number,
      findingsMinor: Schema.Number,
      findingsNit: Schema.Number,
      ciPassed: Schema.NullOr(Schema.Boolean),
      merged: Schema.NullOr(Schema.Boolean),
      filesReverted: Schema.Number,
      planRevisions: Schema.Number,
      sizeBucket: SizeBucket,
      score: Schema.Number,
      occurredOn: Schema.String
    })
  )
})

/**
 * How many outcomes one member may contribute per day.
 *
 * The first rate limit on this server, and this is the endpoint that needed it:
 * `/api/me` is a single indexed read, while a contribution writes rows a whole
 * team then reads. Capping per member per day also bounds how far one heavy user
 * — or one bad actor — can move a shared cell.
 */
const DAILY_CONTRIBUTION_CAP = 500

/**
 * Resolve the caller and the organisation they are acting in.
 *
 * Both are required for every learnings route: sharing is a team feature, and a
 * signed-in user with no active organisation has no pool to read from or
 * contribute to.
 */
const requireOrgMember = async (
  headers: Headers
): Promise<{ userId: string; organizationId: string } | null> => {
  const session = await auth.api.getSession({ headers }).catch(() => null)
  const organizationId = session?.session?.activeOrganizationId
  if (!session?.user || !(await runtime.runPromise(canShareLearnings(organizationId)))) return null
  return { userId: session.user.id, organizationId: organizationId as string }
}

/** Contribute scored outcomes to the caller's organisation. */
app.post("/api/learnings/outcomes", async (c) => {
  const who = await requireOrgMember(c.req.raw.headers)
  if (!who) return c.json({ error: "Unauthorized" }, 401)

  const body = await c.req.json().catch(() => null)
  const decoded = Schema.decodeUnknownEither(ContributionPayload)(body)
  // A malformed body is the client's bug, not ours — 400, never a 500.
  if (decoded._tag === "Left") return c.json({ error: "Invalid payload" }, 400)

  const used = await runtime
    .runPromise(LearningsRepository.contributedToday(who.organizationId, who.userId))
    .catch(() => 0)
  if (used >= DAILY_CONTRIBUTION_CAP) return c.json({ error: "Daily limit reached" }, 429)

  const accepted = decoded.right.outcomes.slice(0, DAILY_CONTRIBUTION_CAP - used)
  const recorded = await runtime
    .runPromise(LearningsRepository.record(who.organizationId, who.userId, accepted))
    .catch(() => null)
  if (recorded === null) return c.json({ error: "Could not record outcomes" }, 500)
  return c.json({ recorded })
})

/** The organisation's pooled view of one repository. */
app.get("/api/learnings/affinity", async (c) => {
  const who = await requireOrgMember(c.req.raw.headers)
  if (!who) return c.json({ error: "Unauthorized" }, 401)

  const repoKey = c.req.query("repoKey")
  if (!repoKey) return c.json({ error: "repoKey is required" }, 400)

  const rows = await runtime
    .runPromise(LearningsRepository.affinity(who.organizationId, repoKey))
    .catch(() => null)
  if (rows === null) return c.json({ error: "Could not read learnings" }, 500)
  return c.json({ rows })
})

/** Delete everything the caller contributed to this organisation. */
app.post("/api/learnings/purge", async (c) => {
  const who = await requireOrgMember(c.req.raw.headers)
  if (!who) return c.json({ error: "Unauthorized" }, 401)
  const purged = await runtime
    .runPromise(LearningsRepository.purge(who.organizationId, who.userId))
    .catch(() => null)
  if (purged === null) return c.json({ error: "Could not purge" }, 500)
  return c.json({ purged })
})

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
