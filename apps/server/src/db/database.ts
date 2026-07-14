/**
 * The Effect seam over Drizzle. Every hand-written DB operation in this service
 * goes through a Repository, and every Repository goes through `Database.run` —
 * so all our query execution has one place for error tagging, tracing, and (later)
 * transactions. `run` is the ONLY sanctioned way to touch the Drizzle client from
 * app code.
 *
 * The one exception is BetterAuth's `drizzleAdapter`, which owns its own queries
 * internally and is handed the raw client directly in `auth.ts`. That's library
 * machinery we don't control; everything WE write uses a Repository.
 */
import { Data, Effect } from "effect"
import { db } from "./client.js"

/** A tagged failure for any Drizzle operation, carrying the logical op name. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** The Drizzle client type, for repositories to type their query callbacks. */
export type DrizzleClient = typeof db

export class Database extends Effect.Service<Database>()("@starbase/server/Database", {
  accessors: true,
  sync: () => ({
    /**
     * Execute a Drizzle query as an Effect, tagging any rejection with the
     * operation name. Repositories are the intended callers.
     */
    run: <A>(
      operation: string,
      query: (client: DrizzleClient) => Promise<A>
    ): Effect.Effect<A, DatabaseError> =>
      Effect.tryPromise({
        try: () => query(db),
        catch: (cause) => new DatabaseError({ operation, cause })
      })
  })
}) {}
