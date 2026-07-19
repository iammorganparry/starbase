import type { Outcome, Session, TaskKind } from "@starbase/core"
import {
  attributePath,
  dayOf,
  rollUpConfidence,
  scoreOutcome,
  sizeBucketFor,
  vendorOf
} from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Layer, Schedule } from "effect"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { GitService } from "./git.js"
import { contribute, sharingEnabled } from "./learnings-sync.js"
import { OutcomeStore } from "./outcome-store.js"
import { ReviewStore } from "./review-store.js"
import { SecretStore } from "./secret-store.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"

/**
 * Learns from finished work, in the background, only with consent, and never
 * noticeably.
 *
 * Five constraints shape this, each from something already learned the hard way
 * in this codebase:
 *
 *  1. **Inert unless enabled.** Off is off — the tick returns before touching a
 *     single store. Not "collects quietly and withholds".
 *  2. **Never competes with the operator's agent.** A tick that starts while a
 *     session is running would contend for the same rate limits the person is
 *     waiting on, so it skips entirely instead.
 *  3. **Idempotent, because quit cannot flush.** `before-quit` is synchronous
 *     and Electron does not await it, so `runtime.dispose()` may never finish.
 *     Correctness rests on every tick being safe to redo, not on shutdown.
 *  4. **Polls, because nothing publishes.** `setSettledStatus` writes and
 *     returns; there is no "session finished" event to subscribe to.
 *  5. **De-dupes through the OutcomeStore's memory-backed set.** A poll loop
 *     whose de-dupe depends on a fallible read is a runaway — see `ReviewStore`.
 *
 * Every failure is swallowed. The operator asked for a coding agent, not a
 * telemetry pipeline, and a learning error must never reach them.
 */

export type DaemonEnv =
  | ConfigService
  | SessionStore
  | OutcomeStore
  | ReviewStore
  | TranscriptStore
  | GitService
  | SecretStore
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths
  | CommandExecutor.CommandExecutor

const DEFAULT_INTERVAL_MINUTES = 20

/** A session is worth harvesting once it has settled and produced something. */
const isSettled = (session: Session): boolean =>
  !session.archived ? session.status === "idle" || session.status === "done" : true

/**
 * The task kind an outcome is filed under.
 *
 * Taken from the plan step when the work came from a plan, because that is the
 * only place a *declared* intent exists. Guessing from file extensions would
 * manufacture a taxonomy the operator never agreed to, and a wrong kind is worse
 * than no outcome — it teaches the wrong cell.
 */
const kindOf = (steps: ReadonlyArray<{ taskKind?: TaskKind }>): TaskKind | null => {
  const kinds = steps.map((s) => s.taskKind).filter((k): k is TaskKind => k !== undefined)
  if (kinds.length === 0) return null
  // The most common declared kind; ties resolve to the first, deterministically.
  const counts = new Map<TaskKind, number>()
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
}

export interface HarvestInput {
  readonly session: Session
  readonly repoKey: string
  /** The approved plan's steps, when the work came from one. */
  readonly steps: ReadonlyArray<{ taskKind?: TaskKind; files: ReadonlyArray<{ path: string }> }>
  readonly findings: ReadonlyArray<{ path: string | null; severity: string }>
  readonly ciPassed: boolean | null
  readonly filesReverted: number
  readonly planRevisions: number
  readonly linesChanged: number
  readonly occurredOn: string
}

/**
 * Turn one settled session into a scored outcome, or null when there isn't
 * enough to say anything honest.
 *
 * Pure, so the whole judgement is testable without a filesystem — and so the
 * decision to DECLINE (no declared task kind, no resolvable vendor) is visible
 * rather than buried in a pipeline.
 */
export const harvest = (input: HarvestInput): Outcome | null => {
  const taskKind = kindOf(input.steps)
  if (taskKind === null) return null
  const vendor = vendorOf(input.session.cli, input.session.model ?? null)
  if (vendor === null) return null
  const model = input.session.model
  if (model === undefined || model.length === 0) return null

  const bySeverity = { critical: 0, major: 0, minor: 0, nit: 0 }
  const attributions = input.findings.flatMap((f) => {
    const severity = f.severity as keyof typeof bySeverity
    if (severity in bySeverity) bySeverity[severity] += 1
    if (f.path === null) return []
    const a = attributePath(input.steps as never, f.path)
    return a === null ? [] : [a]
  })

  // Derived here rather than by the caller so the null/false distinction has one
  // home: "still open" is not "closed unmerged", and the scorer treats them
  // differently.
  const merged =
    input.session.archiveReason === "merged"
      ? true
      : input.session.archiveReason === "closed"
        ? false
        : null

  const signals = {
    findingsCritical: bySeverity.critical,
    findingsMajor: bySeverity.major,
    findingsMinor: bySeverity.minor,
    findingsNit: bySeverity.nit,
    ciPassed: input.ciPassed,
    merged,
    filesReverted: input.filesReverted,
    planRevisions: input.planRevisions
  }

  return {
    id: input.session.id,
    repoKey: input.repoKey,
    taskKind,
    cli: input.session.cli,
    vendor,
    model,
    signals,
    sizeBucket: sizeBucketFor(input.linesChanged),
    confidence: rollUpConfidence(attributions),
    score: scoreOutcome(signals),
    occurredOn: input.occurredOn
  }
}

/** Is any session mid-run right now? Ticks stand down while one is. */
export type IsBusy = () => boolean

/** One pass. Exported so a test can drive it without waiting on a schedule. */
export const tick = (isBusy: IsBusy): Effect.Effect<number, never, DaemonEnv> =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    // Guard FIRST, before any store is touched: "off" must mean nothing is read.
    if (config?.learning?.enabled !== true) return 0
    if (isBusy()) return 0

    const sessions = yield* SessionStore.list()
    let recorded = 0

    for (const session of sessions) {
      if (!isSettled(session) || !session.worktreePath) continue
      const repoKey = yield* GitService.repoKey(session.worktreePath).pipe(
        Effect.orElseSucceed(() => null)
      )
      // No stable identity means no cell to file this under. Recording it against
      // a made-up key would put evidence somewhere nothing can ever read it.
      if (repoKey === null) continue

      const already = yield* OutcomeStore.harvested(repoKey.key)
      if (already.has(session.id)) continue

      const review = yield* ReviewStore.get(session.id).pipe(Effect.orElseSucceed(() => null))
      const messages = yield* TranscriptStore.list(session.id).pipe(Effect.orElseSucceed(() => []))
      const plan = messages
        .flatMap((m) => m.parts)
        .flatMap((p) => (p._tag === "Plan" ? [p.plan] : []))
        .findLast((p) => p.status === "approved")
      if (plan === undefined) continue

      const outcome = harvest({
        session,
        repoKey: repoKey.key,
        steps: plan.steps,
        findings: (review?.findings ?? []).map((f) => ({ path: f.path, severity: f.severity })),
        // PR state is reconciled separately; absent means "not observed", which
        // the scorer keeps distinct from failed/closed.
        ciPassed: null,
        filesReverted: 0,
        planRevisions: plan.comments.filter((c) => c.author === "user").length,
        linesChanged: session.diff.added + session.diff.removed,
        occurredOn: dayOf(new Date(session.updatedAt))
      })
      if (outcome === null) continue
      yield* OutcomeStore.append(outcome)
      recorded += 1
    }

    // Sharing runs last and only when both switches are on. A failure here never
    // touches `recorded` — the outcomes are already safely on disk, and the
    // cursor means an unsent one is simply retried next tick.
    if (sharingEnabled(config)) {
      for (const repoKey of yield* OutcomeStore.repos()) {
        const outcomes = yield* OutcomeStore.list(repoKey)
        const result = yield* contribute(repoKey, outcomes).pipe(
          Effect.orElseSucceed(() => ({ sent: 0, unauthorized: true }))
        )
        // A dead token stops the whole sweep rather than repeating the same
        // rejection once per repository.
        if (result.unauthorized) break
      }
    }

    return recorded
  }).pipe(Effect.orElseSucceed(() => 0))

/**
 * Fork the daemon for the app's lifetime.
 *
 * A layer rather than a handle held in `index.ts`, mirroring how `RpcServerLive`
 * keeps its own daemon alive: the runtime owns the fiber and its interruption,
 * so quitting tears it down without anyone remembering to.
 *
 * The schedule is jittered so a machine with several windows doesn't
 * synchronise every instance onto the same second.
 */
export const learningDaemonLayer = (isBusy: IsBusy): Layer.Layer<never, never, DaemonEnv> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
      const minutes = config?.learning?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
      yield* Effect.forkScoped(
        tick(isBusy).pipe(
          Effect.repeat(
            Schedule.spaced(`${minutes} minutes`).pipe(Schedule.jittered)
          ),
          Effect.ignore
        )
      )
    })
  )
