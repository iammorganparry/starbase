import { assign, setup } from "xstate"
import type { BackgroundTask, BackgroundTaskStatus } from "./conversation.js"

/**
 * The lifecycle of ONE background task, as an explicit statechart.
 *
 * Background tasks are the hardest thing in the app to keep honest, because the
 * harness's signals are unordered and lossy by design:
 *
 *  - `background_tasks_changed` is a LEVEL signal (the full live set), and the
 *    harness explicitly does not guarantee its ordering against the
 *    start/progress/settle EDGES;
 *  - a settle bookend can be missed entirely, and pairing edges to derive "still
 *    running" then wedges a task as running forever;
 *  - a late progress report can arrive after a task has already finished.
 *
 * Ad-hoc `if` branches over a status string get this wrong in ways that only show
 * up as a dock row spinning forever, or a Stop button that looks dead. A
 * statechart makes the legal transitions explicit and total: every event is
 * handled in every state, terminal states ignore everything, and there is no
 * path back out of a terminal state.
 *
 * The state that only exists because of the UI: `stopping`. Stopping is not
 * instant — we ask the harness and it confirms later via a settle bookend (or by
 * dropping the task from the level). Without this state the operator clicks Stop
 * and nothing changes until confirmation lands, so the button reads as broken.
 */

export interface BackgroundTaskContext {
  readonly id: string
  readonly sessionId: string
  readonly description: string
  readonly taskType: string
  readonly subagentType: string | null
  readonly toolUseId: string | null
  readonly tokens: number
  readonly toolUses: number
  readonly durationMs: number
  readonly lastTool: string | null
  readonly summary: string | null
  readonly outputFile: string | null
  readonly startedAt: string
  readonly endedAt: string | null
}

export type BackgroundTaskEvent =
  | {
      type: "PROGRESS"
      description: string
      tokens: number
      toolUses: number
      durationMs: number
      lastTool: string | null
    }
  /** The harness's terminal bookend for this task. */
  | {
      type: "SETTLED"
      status: BackgroundTaskStatus
      summary: string | null
      outputFile: string | null
      now: string
    }
  /** The level signal no longer lists this task — authoritative for liveness. */
  | { type: "ABSENT"; now: string }
  /** The operator asked to stop it; the harness confirms later. */
  | { type: "STOP_REQUESTED" }
  /**
   * No live harness process owns this task any more (the CLI restarted, or the
   * stop found no handle). A background task cannot outlive its process, so this
   * is terminal — leaving the row running would strand an unstoppable id.
   */
  | { type: "ORPHANED"; now: string }

export const backgroundTaskMachine = setup({
  types: {
    context: {} as BackgroundTaskContext,
    events: {} as BackgroundTaskEvent,
    input: {} as BackgroundTaskContext
  },
  actions: {
    recordProgress: assign(({ event }) =>
      event.type === "PROGRESS"
        ? {
            description: event.description,
            tokens: event.tokens,
            toolUses: event.toolUses,
            durationMs: event.durationMs,
            lastTool: event.lastTool
          }
        : {}
    ),
    recordSettled: assign(({ context, event }) =>
      event.type === "SETTLED"
        ? {
            summary: event.summary,
            outputFile: event.outputFile,
            endedAt: context.endedAt ?? event.now
          }
        : {}
    ),
    recordEnded: assign(({ context, event }) =>
      "now" in event ? { endedAt: context.endedAt ?? event.now } : {}
    )
  },
  guards: {
    settledCompleted: ({ event }) => event.type === "SETTLED" && event.status === "completed",
    settledStopped: ({ event }) => event.type === "SETTLED" && event.status === "stopped"
  }
}).createMachine({
  id: "backgroundTask",
  context: ({ input }) => input,
  initial: "running",
  states: {
    running: {
      on: {
        PROGRESS: { actions: "recordProgress" },
        STOP_REQUESTED: { target: "stopping" },
        SETTLED: [
          { guard: "settledCompleted", target: "completed", actions: "recordSettled" },
          { guard: "settledStopped", target: "stopped", actions: "recordSettled" },
          { target: "failed", actions: "recordSettled" }
        ],
        // Gone from the live set with no bookend. The harness says it is not
        // running, and the harness is authoritative — believe it rather than
        // spinning forever waiting for an edge that may never come.
        ABSENT: { target: "completed", actions: "recordEnded" },
        ORPHANED: { target: "completed", actions: "recordEnded" }
      }
    },

    /**
     * Stop asked for, awaiting the harness's confirmation. Progress may still
     * arrive — a task does not halt the instant we ask — and is recorded, but it
     * cannot pull the task back to `running`: the operator's intent stands until
     * the harness settles it either way.
     */
    stopping: {
      on: {
        PROGRESS: { actions: "recordProgress" },
        // Idempotent: clicking Stop twice must not re-enter or reset anything.
        STOP_REQUESTED: {},
        SETTLED: [
          // A task that completed on its own before our stop landed really did
          // complete — report the truth, not the intent.
          { guard: "settledCompleted", target: "completed", actions: "recordSettled" },
          { guard: "settledStopped", target: "stopped", actions: "recordSettled" },
          { target: "failed", actions: "recordSettled" }
        ],
        // Vanished after we asked it to stop: attribute it to the stop.
        ABSENT: { target: "stopped", actions: "recordEnded" },
        ORPHANED: { target: "stopped", actions: "recordEnded" }
      }
    },

    // Terminal. `final` states take no transitions, so a late PROGRESS or a task
    // reappearing in the level cannot resurrect a finished task.
    completed: { type: "final" },
    stopped: { type: "final" },
    failed: { type: "final" }
  }
})

/** The four lifecycle states, as the wire-level status the UI renders. */
export type BackgroundTaskState = "running" | "stopping" | "completed" | "stopped" | "failed"

/** Project a machine snapshot onto the serializable `BackgroundTask` DTO. */
export const toBackgroundTask = (
  state: BackgroundTaskState,
  context: BackgroundTaskContext
): BackgroundTask => ({
  id: context.id,
  sessionId: context.sessionId,
  description: context.description,
  taskType: context.taskType,
  subagentType: context.subagentType,
  // `stopping` is a UI-facing lifecycle state, not a harness outcome. It rides on
  // the wire as its own status so the dock can disable the button and say
  // "Stopping…" rather than pretending the task is already gone.
  status: state as BackgroundTaskStatus,
  toolUseId: context.toolUseId,
  tokens: context.tokens,
  toolUses: context.toolUses,
  durationMs: context.durationMs,
  lastTool: context.lastTool,
  summary: context.summary,
  outputFile: context.outputFile,
  startedAt: context.startedAt,
  endedAt: context.endedAt
})

/** A fresh task context, as created by a start edge or an unseen live id. */
export const newTaskContext = (input: {
  id: string
  sessionId: string
  description: string
  taskType: string
  subagentType?: string | null
  toolUseId?: string | null
  startedAt: string
}): BackgroundTaskContext => ({
  id: input.id,
  sessionId: input.sessionId,
  description: input.description,
  taskType: input.taskType,
  subagentType: input.subagentType ?? null,
  toolUseId: input.toolUseId ?? null,
  tokens: 0,
  toolUses: 0,
  durationMs: 0,
  lastTool: null,
  summary: null,
  outputFile: null,
  startedAt: input.startedAt,
  endedAt: null
})
