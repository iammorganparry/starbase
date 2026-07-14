/**
 * Postgres client + Drizzle instance, created ONCE at module scope. On Vercel the
 * function module is reused across warm invocations, so a module-scoped client
 * (rather than one-per-request) avoids exhausting connections. `prepare: false`
 * keeps it compatible with a transaction-mode connection pooler (PgBouncer /
 * Supabase / Neon) in production; `postgres.js` connects lazily on first query,
 * so importing this never opens a socket.
 */
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { env } from "../env.js"
import { schema } from "./schema.js"

export const sql = postgres(env.databaseUrl, {
  max: env.isDev ? 10 : 1,
  prepare: false
})

export const db = drizzle(sql, { schema })
