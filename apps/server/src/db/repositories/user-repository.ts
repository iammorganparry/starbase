/**
 * Read access to the `user` table. Writes to users are owned by BetterAuth (sign
 * up / OAuth link), so this is intentionally read-only for now; add mutations
 * here (never inline in a route) if the product ever needs them.
 */
import { asc, eq } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database, type DatabaseError, type DrizzleClient } from "../database.js"
import { user } from "../schema.js"

type UserRow = typeof user.$inferSelect

/** The user projection the rest of the app consumes. */
export interface UserRecord {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly image: string | null
  readonly emailVerified: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

const toRecord = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  name: row.name,
  image: row.image,
  emailVerified: row.emailVerified,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
})

export class UserRepository extends Effect.Service<UserRepository>()(
  "@starbase/server/UserRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const database = yield* Database

      /** Run a query expected to return at most one row → Option. */
      const findOne = (
        operation: string,
        query: (client: DrizzleClient) => Promise<Array<UserRow>>
      ): Effect.Effect<Option.Option<UserRecord>, DatabaseError> =>
        database
          .run(operation, query)
          .pipe(Effect.map((rows) => Option.fromNullable(rows[0]).pipe(Option.map(toRecord))))

      return {
        findById: (id: string) =>
          findOne("UserRepository.findById", (db) =>
            db.select().from(user).where(eq(user.id, id)).limit(1)
          ),
        findByEmail: (email: string) =>
          findOne("UserRepository.findByEmail", (db) =>
            db.select().from(user).where(eq(user.email, email)).limit(1)
          ),
        list: (): Effect.Effect<ReadonlyArray<UserRecord>, DatabaseError> =>
          database
            .run("UserRepository.list", (db) => db.select().from(user).orderBy(asc(user.createdAt)))
            .pipe(Effect.map((rows) => rows.map(toRecord)))
      } as const
    })
  }
) {}
