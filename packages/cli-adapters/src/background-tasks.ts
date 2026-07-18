import type { BackgroundTask, BackgroundTaskState, StreamEvent } from "@starbase/core"
import { backgroundTaskMachine, newTaskContext, toBackgroundTask } from "@starbase/core"
import { Effect, Ref } from "effect"
import type { Actor } from "xstate"
import { createActor } from "xstate"
import type { StopBackgroundTask } from "./adapter.js"

type TaskActor = Actor<typeof backgroundTaskMachine>

/**
 * Session-scoped registry of background tasks — work the harness is running that
 * OUTLIVES the turn that started it.
 *
 * Why this lives in the main process rather than the renderer's conversation
 * state: sub-agent tabs are per-run and cleared when the next run starts, which
 * is right for a tab showing that turn's delegated work. A background task's
 * defining property is the opposite — it keeps running after the turn ends, and
 * the operator needs to see and stop it while later turns come and go. Holding
 * it in per-run renderer state would delete the row the moment the next prompt
 * was sent, while the work carried on invisibly.
 *
 * Every task is one `backgroundTaskMachine` actor, so the store never decides a
 * status itself — it translates harness signals into machine events and reads
 * the result back. That is what keeps the lifecycle deterministic in the face of
 * a level signal with no ordering guarantee, droppable settle bookends, and
 * progress reports that arrive after a task has finished.
 *
 * In memory, deliberately NOT persisted: a background task cannot outlive the
 * harness process that owns it, so a task restored from disk after an app
 * restart could never settle and its id would resolve to nothing stoppable.
 */
export class BackgroundTaskStore extends Effect.Service<BackgroundTaskStore>()(
  "@starbase/BackgroundTaskStore",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const actors = yield* Ref.make(new Map<string, Map<string, TaskActor>>())
      // Stop handles are per-session and replaced on each run: the handle closes
      // over the live harness query, so the newest run's is the only valid one.
      const stops = yield* Ref.make(new Map<string, StopBackgroundTask>())

      const now = Effect.sync(() => new Date().toISOString())

      const forSession = (sessionId: string): Effect.Effect<Map<string, TaskActor>> =>
        Ref.get(actors).pipe(Effect.map((m) => m.get(sessionId) ?? new Map()))

      const snapshot = (actor: TaskActor): BackgroundTask => {
        const s = actor.getSnapshot()
        return toBackgroundTask(s.value as BackgroundTaskState, s.context)
      }

      const list = (sessionId: string): Effect.Effect<ReadonlyArray<BackgroundTask>> =>
        forSession(sessionId).pipe(Effect.map((m) => [...m.values()].map(snapshot)))

      /** Start (or return) the actor for `taskId`. */
      const ensure = (
        sessionId: string,
        taskId: string,
        init: { description: string; taskType: string; subagentType?: string | null; toolUseId?: string | null }
      ): Effect.Effect<TaskActor> =>
        Effect.gen(function* () {
          const existing = (yield* forSession(sessionId)).get(taskId)
          if (existing) return existing
          const startedAt = yield* now
          const actor = createActor(backgroundTaskMachine, {
            input: newTaskContext({ id: taskId, sessionId, startedAt, ...init })
          }).start()
          yield* Ref.update(actors, (m) => {
            const next = new Map(m)
            const session = new Map(next.get(sessionId) ?? [])
            session.set(taskId, actor)
            return next.set(sessionId, session)
          })
          return actor
        })

      const send = (sessionId: string, taskId: string, event: Parameters<TaskActor["send"]>[0]) =>
        forSession(sessionId).pipe(
          Effect.map((m) => m.get(taskId)),
          Effect.tap((actor) => Effect.sync(() => actor?.send(event))),
          Effect.asVoid
        )

      /** Translate one stream event into machine events for this session. */
      const ingest = (sessionId: string, event: StreamEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (event._tag === "BackgroundTaskStarted") {
            yield* ensure(sessionId, event.id, {
              description: event.description,
              taskType: event.taskType,
              subagentType: event.subagentType,
              toolUseId: event.toolUseId
            })
            return
          }

          if (event._tag === "BackgroundTaskProgress") {
            yield* send(sessionId, event.id, {
              type: "PROGRESS",
              description: event.description,
              tokens: event.tokens,
              toolUses: event.toolUses,
              durationMs: event.durationMs,
              lastTool: event.lastTool
            })
            return
          }

          if (event._tag === "BackgroundTaskSettled") {
            yield* send(sessionId, event.id, {
              type: "SETTLED",
              status: event.status,
              summary: event.summary,
              outputFile: event.outputFile,
              now: yield* now
            })
            return
          }

          if (event._tag === "BackgroundTasksChanged") {
            const live = new Set(event.ids)
            // An id in the level we have no actor for means we missed its start
            // edge. Better a row with a placeholder label than work running with
            // no row at all.
            for (const id of event.ids) {
              yield* ensure(sessionId, id, { description: "Background task", taskType: "unknown" })
            }
            // The level is authoritative for liveness: anything still live here
            // but absent from the level has finished, whether or not its bookend
            // ever arrived.
            const stamp = yield* now
            for (const [id, actor] of yield* forSession(sessionId)) {
              const state = actor.getSnapshot().value
              if ((state === "running" || state === "stopping") && !live.has(id)) {
                yield* Effect.sync(() => actor.send({ type: "ABSENT", now: stamp }))
              }
            }
          }
        })

      /**
       * Register the current run's stop handle, orphaning anything the PREVIOUS
       * harness process left running. The live set is per-process and nothing is
       * emitted at startup, so a row carried across a restart would spin forever
       * with an id that resolves to nothing.
       */
      const registerStop = (sessionId: string, stop: StopBackgroundTask): Effect.Effect<void> =>
        Effect.gen(function* () {
          const stamp = yield* now
          for (const actor of (yield* forSession(sessionId)).values()) {
            yield* Effect.sync(() => actor.send({ type: "ORPHANED", now: stamp }))
          }
          yield* Ref.update(stops, (m) => new Map(m).set(sessionId, stop))
        })

      /**
       * Ask the harness to stop one task.
       *
       * The machine moves to `stopping` FIRST, so the dock reflects the operator's
       * click immediately rather than looking dead until the harness confirms.
       * With no handle there is no live process, so the task is already gone —
       * orphan it rather than leaving a row that can never settle.
       */
      const stop = (sessionId: string, taskId: string): Effect.Effect<BackgroundTask | null> =>
        Effect.gen(function* () {
          const actor = (yield* forSession(sessionId)).get(taskId)
          if (!actor) return null
          yield* Effect.sync(() => actor.send({ type: "STOP_REQUESTED" }))
          const handle = (yield* Ref.get(stops)).get(sessionId)
          if (!handle) {
            const stamp = yield* now
            yield* Effect.sync(() => actor.send({ type: "ORPHANED", now: stamp }))
            return snapshot(actor)
          }
          // FORKED, not awaited. The harness confirms a stop asynchronously (via
          // the level signal or a settle bookend), and `stopTask` is under no
          // obligation to resolve promptly — awaiting it would hang the operator's
          // click on a request whose answer arrives by another route entirely.
          // Rejections are ignored for the same reason: the row stays `stopping`
          // until the harness says otherwise, which is the honest state.
          yield* Effect.forkDaemon(Effect.tryPromise(() => handle(taskId)).pipe(Effect.ignore))
          return snapshot(actor)
        })

      /** Drop a session's tasks entirely (session deleted). */
      const clear = (sessionId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const actor of (yield* forSession(sessionId)).values()) {
            yield* Effect.sync(() => actor.stop())
          }
          yield* Ref.update(actors, (m) => {
            const next = new Map(m)
            next.delete(sessionId)
            return next
          })
          yield* Ref.update(stops, (m) => {
            const next = new Map(m)
            next.delete(sessionId)
            return next
          })
        })

      return { list, ingest, registerStop, stop, clear }
    })
  }
) {}
