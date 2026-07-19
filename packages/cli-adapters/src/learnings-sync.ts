import type { Outcome, WorkspaceConfig } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Ref, Schedule } from "effect"
import { AppPaths } from "./app-paths.js"
import { SecretStore } from "./secret-store.js"

/**
 * Contributing this machine's outcomes to the team's pool, and reading theirs
 * back.
 *
 * Off by default and FAIL-CLOSED under the learning switch: turning learning off
 * disables sharing regardless of its own flag, because a stale `sharing: true`
 * would otherwise keep sending after the operator believed they had switched
 * everything off.
 *
 * Everything here is best-effort and lossless. A failed sync must never lose an
 * outcome and must never surface an error — the operator asked for a coding
 * agent, not a telemetry pipeline. The queue is the on-disk corpus itself plus a
 * cursor, so there is no second store to fall out of sync with it.
 */

type SyncEnv = FileSystem.FileSystem | Path.Path | AppPaths | SecretStore

/** Base URL of the backend. Read per call so an env change needs no restart. */
const authBaseUrl = (): string => process.env.STARBASE_AUTH_URL ?? "http://localhost:9100"

/**
 * Whether sharing may run at all.
 *
 * Both switches, in that order. `sharing` alone is never sufficient — see the
 * fail-closed note above, which mirrors how the repo already gates
 * `autoAdversarialReview` behind its master switch.
 */
export const sharingEnabled = (config: WorkspaceConfig | null): boolean =>
  config?.learning?.enabled === true && config.learning.sharing === true

/**
 * Which outcomes are eligible to leave this machine.
 *
 * Two filters, both deliberate:
 *
 *  - **Already sent** (id in the cursor). The server de-dupes too, but sending
 *    the whole corpus every tick would grow linearly with history for no gain.
 *  - **Ambiguous attribution.** A local cell can afford a discounted guess; a
 *    SHARED cell cannot, because a teammate reading it has no way to know one
 *    contributor's evidence was fuzzy. Pooled data stays cleaner than any one
 *    machine's.
 */
export const pendingFor = (
  outcomes: ReadonlyArray<Outcome>,
  alreadySent: ReadonlySet<string>
): ReadonlyArray<Outcome> =>
  outcomes.filter((o) => o.confidence === "exact" && !alreadySent.has(o.id))

/** How many outcomes go in one request. Bounded so a long history doesn't spike. */
const BATCH = 100

/**
 * Retry policy for a contribution.
 *
 * Exponential, capped, and few — the repo's first backoff, and deliberately
 * modest: the daemon will come round again in minutes anyway, so hammering a
 * struggling server inside one tick buys nothing. Anything still failing is left
 * queued rather than dropped.
 */
export const DEFAULT_RETRY = Schedule.exponential("500 millis").pipe(
  Schedule.compose(Schedule.recurs(3))
)

export interface SyncResult {
  readonly sent: number
  /** True when the token was rejected — the caller stops trying until sign-in. */
  readonly unauthorized: boolean
}

/**
 * POST to the backend WITH the bearer token.
 *
 * `AuthService.post` deliberately attaches no credential (it serves the
 * unauthenticated sign-in flows), so this is a separate helper rather than a
 * parameter on that one.
 *
 * It copies `AuthService.getSession`'s transient-vs-fatal rule exactly, and that
 * distinction is the whole reliability story: a network error is transient, so
 * the outcomes stay queued and the token is kept; a 401 is fatal, so we stop
 * trying rather than retrying a dead token every tick forever.
 */
/**
 * Why a contribution failed. The two are handled completely differently, so they
 * are separate values rather than a boolean: transient is worth retrying,
 * `unauthorized` never is.
 */
type PostFailure = { readonly _tag: "Transient" } | { readonly _tag: "Unauthorized" }

const authedPost = (
  path: string,
  payload: unknown
): Effect.Effect<void, PostFailure, SecretStore> =>
  Effect.gen(function* () {
    const secrets = yield* SecretStore
    const token = yield* secrets.get
    if (token === null) return yield* Effect.fail({ _tag: "Unauthorized" } as const)
    const res = yield* Effect.tryPromise(() =>
      fetch(`${authBaseUrl()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      })
    ).pipe(Effect.orElseSucceed(() => null))
    if (res === null) return yield* Effect.fail({ _tag: "Transient" } as const)
    if (res.status === 401) return yield* Effect.fail({ _tag: "Unauthorized" } as const)
    if (!res.ok) return yield* Effect.fail({ _tag: "Transient" } as const)
  })

/** The cursor file for a repo — beside the outcomes, never in `config.json`. */
const cursorFile = (repoKey: string): Effect.Effect<string, never, Path.Path | AppPaths> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const paths = yield* AppPaths
    return path.join(paths.outcomesDir, `${repoKey}.sent`)
  })

/**
 * Ids already contributed for this repo.
 *
 * Kept beside the outcomes rather than in `config.json` on purpose:
 * `ConfigService.patch` is an unlocked read-modify-write, so a background writer
 * racing the settings panel silently drops one of them — and losing the cursor
 * would re-send the entire history.
 */
export const readCursor = (repoKey: string): Effect.Effect<ReadonlySet<string>, never, SyncEnv> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* cursorFile(repoKey)
    const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    return new Set(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    )
  })

const appendCursor = (
  repoKey: string,
  ids: ReadonlyArray<string>
): Effect.Effect<void, never, SyncEnv> =>
  Effect.gen(function* () {
    if (ids.length === 0) return
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    const file = yield* cursorFile(repoKey)
    yield* fs.makeDirectory(paths.outcomesDir, { recursive: true }).pipe(Effect.ignore)
    // Appended AFTER a confirmed 2xx. Recording optimistically would drop an
    // outcome on a failure, and re-sending is free because the server de-dupes.
    yield* fs.writeFileString(file, `${ids.join("\n")}\n`, { flag: "a" }).pipe(Effect.ignore)
  })

/**
 * Strip an outcome to exactly what the wire schema accepts.
 *
 * Exported so the settings pane's "here is what is shared" copy can be checked
 * against what actually travels. A promise about data that drifts from the code
 * is worse than no promise, so a test derives the field list from THIS function
 * and fails when the two disagree.
 */
export const toContribution = (o: Outcome) => ({
  id: o.id,
  repoKey: o.repoKey,
  taskKind: o.taskKind,
  cli: o.cli,
  vendor: o.vendor,
  model: o.model,
  ...o.signals,
  sizeBucket: o.sizeBucket,
  score: o.score,
  occurredOn: o.occurredOn
})

/**
 * Contribute this repo's eligible outcomes, in batches.
 *
 * Returns how many were accepted. Stops at the first batch that fails: the rest
 * stay queued for the next tick, which is the whole point of a cursor.
 */
export const contribute = (
  repoKey: string,
  outcomes: ReadonlyArray<Outcome>,
  /**
   * Injectable so tests don't pay real backoff. A suite that sleeps for seconds
   * on every retry path competes with the timing-sensitive tests beside it —
   * which is how this repo's terminal and SIGKILL suites start flaking.
   */
  retry: Schedule.Schedule<unknown, PostFailure> = DEFAULT_RETRY
): Effect.Effect<SyncResult, never, SyncEnv> =>
  Effect.gen(function* () {
    const sent = yield* readCursor(repoKey)
    const pending = pendingFor(outcomes, sent)
    if (pending.length === 0) return { sent: 0, unauthorized: false }

    const total = yield* Ref.make(0)
    const stopped = yield* Ref.make(false)

    for (let i = 0; i < pending.length; i += BATCH) {
      if (yield* Ref.get(stopped)) break
      const batch = pending.slice(i, i + BATCH)
      // Retry ONLY the transient failures. A rejected token is not worth
      // retrying — it will be rejected identically three more times, and then
      // once per repository, and then again every tick.
      const result = yield* authedPost("/api/learnings/outcomes", {
        outcomes: batch.map(toContribution)
      }).pipe(
        Effect.retry({ schedule: retry, while: (e: PostFailure) => e._tag === "Transient" }),
        Effect.either
      )
      if (result._tag === "Left") {
        yield* Ref.set(stopped, true)
        if (result.left._tag === "Unauthorized") {
          return { sent: yield* Ref.get(total), unauthorized: true }
        }
        break
      }
      yield* appendCursor(repoKey, batch.map((o) => o.id))
      yield* Ref.update(total, (n) => n + batch.length)
    }
    return { sent: yield* Ref.get(total), unauthorized: false }
  })

/** Forget what has been contributed for a repo — part of the purge. */
export const clearCursor = (repoKey: string): Effect.Effect<void, never, SyncEnv> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* cursorFile(repoKey)
    yield* fs.remove(file).pipe(Effect.ignore)
  })
