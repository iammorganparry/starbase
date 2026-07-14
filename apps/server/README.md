# @starbase/server

The Starbase auth backend — [BetterAuth](https://www.better-auth.com/) over
Postgres/Drizzle, served by [Hono](https://hono.dev/). Runs locally under
`@hono/node-server` and deploys to Vercel unchanged (`api/[[...route]].ts`).

The desktop app is gated behind a sign-in wall and authenticates against this
service with a bearer token held in the OS keychain. Sign-in methods: **GitHub
OAuth**, **Google OAuth**, and **email magic link**.

## Local development

Everything runs offline — no OAuth apps or email provider needed. Magic-link URLs
are printed to the server console.

```bash
# 1. Start Postgres (repo root)
docker compose up -d db            # postgres:16 on localhost:5433

# 2. Configure
cp apps/server/.env.example apps/server/.env

# 3. Create the auth tables
pnpm --filter @starbase/server db:migrate

# 4. Run the server
pnpm --filter @starbase/server dev # http://localhost:9100
```

Health check: `curl http://localhost:9100/health` → `{"status":"ok",…}`.

Request a magic link (the link is logged to the server console):

```bash
curl -X POST http://localhost:9100/api/auth/sign-in/magic-link \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","callbackURL":"http://localhost:9100/desktop/callback"}'
```

## The desktop bridge

OAuth and magic-link flows finish in the user's browser, where the session is a
cookie the desktop app can't read. The client sets `GET /desktop/callback` as its
`callbackURL`; that route reads the fresh session server-side and 302-redirects to
`starbase://auth/callback?token=<bearer>`, which the desktop stores in the OS
keychain. From then on it calls the API with `Authorization: Bearer <token>`.

## Database access — Repositories via an Effect service

All hand-written DB access goes through the Effect-TS stack, never inline in a
route:

```
Hono route → runtime.runPromise(...) → Repository (Effect.Service) → Database.run → Drizzle
```

- `db/database.ts` — the `Database` Effect service. `Database.run(op, query)` is the
  only sanctioned way to execute a Drizzle query; it tags failures as `DatabaseError`.
- `db/repositories/*.ts` — one `Effect.Service` per aggregate (e.g. `UserRepository`),
  depending on `Database`, exposing typed methods that return `Effect`s. Add a
  repository, `provideMerge` its `.Default` in `runtime.ts`, and it's available to
  every handler.
- `runtime.ts` — a single `ManagedRuntime` wiring `Database` + the repositories.

Example consumer: `GET /api/me` validates the bearer session (BetterAuth) then loads
the user via `UserRepository.findById`.

**The one exception** is BetterAuth's `drizzleAdapter`, which owns its own queries
internally and is handed the raw Drizzle client directly in `auth.ts`. That's library
machinery; everything we write uses a repository. Route/app code must not import
`db/client.ts` directly.

## Schema

Drizzle schema (`src/db/schema.ts`) is BetterAuth's core tables: `user`,
`session`, `account`, `verification`. Downstream paid-user tables (billing,
subscriptions) reference `user.id`.

```bash
pnpm --filter @starbase/server db:generate   # generate a migration from schema.ts
pnpm --filter @starbase/server db:migrate     # apply migrations
pnpm --filter @starbase/server db:studio      # drizzle-kit studio
```

The client uses `postgres.js` with `prepare:false` and a module-scoped instance,
so it is safe behind a transaction-mode pooler (Supabase/Neon/PgBouncer) on
serverless.

## Environment

See `.env.example`. Required in production:

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Managed Postgres, ideally via a pooler. |
| `BETTER_AUTH_SECRET` | Strong random value (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | Public URL of this service. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app. Callback: `<BETTER_AUTH_URL>/api/auth/callback/github`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client. Redirect: `<BETTER_AUTH_URL>/api/auth/callback/google`. |
| `RESEND_API_KEY` | Magic-link email. Omit in dev to log links to the console. |

A social provider is only enabled when both its id + secret are set, so dev works
with magic links alone.

## Testing

```bash
pnpm --filter @starbase/server test              # unit — repositories vs a fake Database (CI-safe)
pnpm --filter @starbase/server test:integration  # HTTP e2e vs real Postgres (needs docker compose up -d db + db:migrate)
```

`test:integration` drives the full auth flow through Hono's `app.request` against
a real database: magic-link → session → bearer → `/api/me` → sign out. It's
excluded from `pnpm test` (and CI), which has no Postgres.

The desktop sign-in flow is covered by Playwright e2e in
`apps/desktop/e2e/auth.spec.ts` (`pnpm --filter @starbase/desktop e2e`), against an
offline fake auth backend.

## Deploying to Vercel

Set the project root to `apps/server`. `vercel.json` rewrites all traffic to the
`api/[[...route]].ts` catch-all, which adapts the Hono app via `hono/vercel` on
the **Node** runtime (Postgres/Drizzle need Node, not edge). Set the env vars
above in the Vercel project.
