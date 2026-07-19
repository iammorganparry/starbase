import { and, avg, count, countDistinct, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database, type DatabaseError } from "../database.js"
import { repoModelOutcome } from "../schema.js"

/**
 * A team's pooled learnings.
 *
 * **Organisation scoping lives here, not in the route.** Every method takes
 * `organizationId` as its FIRST argument and every query filters on it, so the
 * repository cannot express an unscoped read at all. A route that forgets a
 * filter is a cross-tenant leak; a repository that has no unscoped query to
 * forget is not. That asymmetry is the whole reason this file is shaped this
 * way.
 *
 * **Aggregates never expose `userId`.** It is stored for abuse control and rate
 * limiting, but the question a team asks is how a MODEL performed — attributing
 * a bad outcome to a named teammate would poison the feature inside a team
 * faster than any technical failure.
 */

/** What one contribution carries. Mirrors the desktop's closed `Outcome`. */
export interface OutcomeContribution {
  readonly id: string
  readonly repoKey: string
  readonly taskKind: string
  readonly cli: string
  readonly vendor: string
  readonly model: string
  readonly findingsCritical: number
  readonly findingsMajor: number
  readonly findingsMinor: number
  readonly findingsNit: number
  readonly ciPassed: boolean | null
  readonly merged: boolean | null
  readonly filesReverted: number
  readonly planRevisions: number
  readonly sizeBucket: string
  readonly score: number
  readonly occurredOn: string
}

/** A team's pooled view of one (model, kind) cell. */
export interface AffinityRow {
  readonly cli: string
  readonly vendor: string
  readonly model: string
  readonly taskKind: string
  readonly observations: number
  readonly meanScore: number
  /** How many distinct people contributed — how broad the evidence is. */
  readonly contributors: number
}

export class LearningsRepository extends Effect.Service<LearningsRepository>()(
  "@starbase/server/LearningsRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const database = yield* Database

      return {
        /**
         * Record contributions for one member of one organisation.
         *
         * Idempotent on (org, user, id): a client retrying after a failed sync
         * must not double-count its own outcome, and the desktop's queue retries
         * with backoff by design.
         */
        record: (
          organizationId: string,
          userId: string,
          outcomes: ReadonlyArray<OutcomeContribution>
        ): Effect.Effect<number, DatabaseError> =>
          outcomes.length === 0
            ? Effect.succeed(0)
            : database
                .run("LearningsRepository.record", (db) =>
                  db
                    .insert(repoModelOutcome)
                    .values(
                      outcomes.map((o) => ({
                        // Namespaced so two members' ids cannot collide — a
                        // session id is only unique on its own machine.
                        id: `${organizationId}:${userId}:${o.id}`,
                        organizationId,
                        userId,
                        repoKey: o.repoKey,
                        taskKind: o.taskKind,
                        cli: o.cli,
                        vendor: o.vendor,
                        model: o.model,
                        findingsCritical: o.findingsCritical,
                        findingsMajor: o.findingsMajor,
                        findingsMinor: o.findingsMinor,
                        findingsNit: o.findingsNit,
                        ciPassed: o.ciPassed,
                        merged: o.merged,
                        filesReverted: o.filesReverted,
                        planRevisions: o.planRevisions,
                        sizeBucket: o.sizeBucket,
                        score: o.score,
                        occurredOn: o.occurredOn
                      }))
                    )
                    .onConflictDoNothing()
                    .returning({ id: repoModelOutcome.id })
                )
                .pipe(Effect.map((rows) => rows.length)),

        /**
         * The organisation's pooled view of one repository.
         *
         * Scoped by organisation AND repo in the WHERE clause, never filtered
         * afterwards in JavaScript — an over-fetch that is narrowed later is one
         * refactor away from being a leak.
         */
        affinity: (
          organizationId: string,
          repoKey: string
        ): Effect.Effect<ReadonlyArray<AffinityRow>, DatabaseError> =>
          database
            .run("LearningsRepository.affinity", (db) =>
              db
                .select({
                  cli: repoModelOutcome.cli,
                  vendor: repoModelOutcome.vendor,
                  model: repoModelOutcome.model,
                  taskKind: repoModelOutcome.taskKind,
                  observations: count(),
                  meanScore: avg(repoModelOutcome.score),
                  contributors: countDistinct(repoModelOutcome.userId)
                })
                .from(repoModelOutcome)
                .where(
                  and(
                    eq(repoModelOutcome.organizationId, organizationId),
                    eq(repoModelOutcome.repoKey, repoKey)
                  )
                )
                .groupBy(
                  repoModelOutcome.cli,
                  repoModelOutcome.vendor,
                  repoModelOutcome.model,
                  repoModelOutcome.taskKind
                )
            )
            .pipe(
              Effect.map((rows) =>
                rows.map((r) => ({
                  cli: r.cli,
                  vendor: r.vendor,
                  model: r.model,
                  taskKind: r.taskKind,
                  observations: Number(r.observations),
                  meanScore: Number(r.meanScore ?? 0),
                  contributors: Number(r.contributors)
                }))
              )
            ),

        /**
         * Delete everything one member contributed to an organisation.
         *
         * Scoped to the caller's own rows deliberately: purge is a personal
         * action, and letting one member erase a colleague's evidence would make
         * a shared corpus impossible to trust.
         */
        purge: (organizationId: string, userId: string): Effect.Effect<number, DatabaseError> =>
          database
            .run("LearningsRepository.purge", (db) =>
              db
                .delete(repoModelOutcome)
                .where(
                  and(
                    eq(repoModelOutcome.organizationId, organizationId),
                    eq(repoModelOutcome.userId, userId)
                  )
                )
                .returning({ id: repoModelOutcome.id })
            )
            .pipe(Effect.map((rows) => rows.length)),

        /** How many outcomes a member contributed today — the rate limit's input. */
        contributedToday: (
          organizationId: string,
          userId: string
        ): Effect.Effect<number, DatabaseError> =>
          database
            .run("LearningsRepository.contributedToday", (db) =>
              db
                .select({ n: count() })
                .from(repoModelOutcome)
                .where(
                  and(
                    eq(repoModelOutcome.organizationId, organizationId),
                    eq(repoModelOutcome.userId, userId),
                    sql`${repoModelOutcome.createdAt} > now() - interval '1 day'`
                  )
                )
            )
            .pipe(Effect.map((rows) => Number(rows[0]?.n ?? 0)))
      } as const
    })
  }
) {}
