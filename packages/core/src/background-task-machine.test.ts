import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import type { BackgroundTaskEvent } from "./background-task-machine.js"
import { backgroundTaskMachine, newTaskContext, toBackgroundTask } from "./background-task-machine.js"

/**
 * The transition table, asserted directly. Background tasks are driven by
 * harness signals that are unordered and lossy by design — a level signal with
 * no ordering guarantee against the edges, settle bookends that can go missing,
 * progress reports that arrive after the task has finished. The statechart
 * exists so those cases have ONE defined answer each instead of whatever a chain
 * of `if`s happened to do.
 */

const NOW = "2026-07-18T12:00:00.000Z"
const LATER = "2026-07-18T12:05:00.000Z"

const start = (over: Partial<Parameters<typeof newTaskContext>[0]> = {}) =>
  createActor(backgroundTaskMachine, {
    input: newTaskContext({
      id: "t1",
      sessionId: "s1",
      description: "run the suite",
      taskType: "bash",
      startedAt: NOW,
      ...over
    })
  }).start()

const drive = (events: ReadonlyArray<BackgroundTaskEvent>) => {
  const actor = start()
  for (const e of events) actor.send(e)
  return actor.getSnapshot()
}

const progress = (over: Partial<Extract<BackgroundTaskEvent, { type: "PROGRESS" }>> = {}) =>
  ({
    type: "PROGRESS",
    description: "still going",
    tokens: 4200,
    toolUses: 7,
    durationMs: 31_000,
    lastTool: "Bash",
    ...over
  }) satisfies BackgroundTaskEvent

const settled = (
  status: "completed" | "failed" | "stopped",
  over: Partial<Extract<BackgroundTaskEvent, { type: "SETTLED" }>> = {}
) =>
  ({
    type: "SETTLED",
    status,
    summary: `${status} summary`,
    outputFile: "/tmp/task.jsonl",
    now: LATER,
    ...over
  }) satisfies BackgroundTaskEvent

describe("backgroundTaskMachine", () => {
  it("starts running with zeroed progress", () => {
    const snapshot = start().getSnapshot()
    expect(snapshot.value).toBe("running")
    expect(snapshot.context).toMatchObject({ tokens: 0, toolUses: 0, lastTool: null, endedAt: null })
  })

  it("records progress without leaving running", () => {
    const snapshot = drive([progress()])
    expect(snapshot.value).toBe("running")
    expect(snapshot.context).toMatchObject({
      description: "still going",
      tokens: 4200,
      toolUses: 7,
      durationMs: 31_000,
      lastTool: "Bash"
    })
  })

  it("routes each settle status to its own terminal state", () => {
    expect(drive([settled("completed")]).value).toBe("completed")
    expect(drive([settled("failed")]).value).toBe("failed")
    expect(drive([settled("stopped")]).value).toBe("stopped")
  })

  it("captures the summary and transcript path on settle", () => {
    const snapshot = drive([settled("completed")])
    expect(snapshot.context).toMatchObject({
      summary: "completed summary",
      outputFile: "/tmp/task.jsonl",
      endedAt: LATER
    })
  })

  it("treats absence from the live set as completion", () => {
    // The harness may drop a settle bookend entirely. Pairing edges to derive
    // liveness would wedge the row as running forever; the level is authoritative.
    const snapshot = drive([{ type: "ABSENT", now: LATER }])
    expect(snapshot.value).toBe("completed")
    expect(snapshot.context.endedAt).toBe(LATER)
  })

  it("enters stopping — not stopped — when the operator asks", () => {
    // The whole reason `stopping` exists: the harness confirms later, so without
    // this state the button appears to do nothing.
    const snapshot = drive([{ type: "STOP_REQUESTED" }])
    expect(snapshot.value).toBe("stopping")
    expect(snapshot.context.endedAt).toBeNull()
  })

  it("keeps recording progress while stopping, without reverting to running", () => {
    // A task does not halt the instant we ask. The operator's intent stands.
    const snapshot = drive([{ type: "STOP_REQUESTED" }, progress({ tokens: 9000 })])
    expect(snapshot.value).toBe("stopping")
    expect(snapshot.context.tokens).toBe(9000)
  })

  it("is idempotent under repeated stop requests", () => {
    const snapshot = drive([{ type: "STOP_REQUESTED" }, { type: "STOP_REQUESTED" }])
    expect(snapshot.value).toBe("stopping")
  })

  it("attributes a vanish-after-stop to the stop", () => {
    const snapshot = drive([{ type: "STOP_REQUESTED" }, { type: "ABSENT", now: LATER }])
    expect(snapshot.value).toBe("stopped")
  })

  it("reports the truth when a task completes before the stop lands", () => {
    // Racing the operator: it really did finish on its own, so say so rather
    // than reporting the intent we happened to send first.
    const snapshot = drive([{ type: "STOP_REQUESTED" }, settled("completed")])
    expect(snapshot.value).toBe("completed")
  })

  it("marks an orphaned task terminal — it cannot outlive its harness process", () => {
    expect(drive([{ type: "ORPHANED", now: LATER }]).value).toBe("completed")
    expect(drive([{ type: "STOP_REQUESTED" }, { type: "ORPHANED", now: LATER }]).value).toBe("stopped")
  })

  it("cannot be resurrected out of a terminal state", () => {
    // Late progress and a task reappearing in the level are both real, and both
    // must be inert. `final` states are what guarantee that structurally.
    for (const terminal of [settled("completed"), settled("failed"), settled("stopped")]) {
      const actor = start()
      actor.send(terminal)
      const before = actor.getSnapshot()
      actor.send(progress({ tokens: 99_999 }))
      actor.send({ type: "STOP_REQUESTED" })
      actor.send({ type: "ABSENT", now: "2026-07-18T13:00:00.000Z" })
      const after = actor.getSnapshot()
      expect(after.value).toBe(before.value)
      expect(after.context).toStrictEqual(before.context)
    }
  })

  it("keeps the FIRST endedAt when several terminal signals arrive", () => {
    const actor = start()
    actor.send(settled("completed", { now: NOW }))
    actor.send({ type: "ABSENT", now: LATER })
    expect(actor.getSnapshot().context.endedAt).toBe(NOW)
  })

  it("handles every event in every non-terminal state", () => {
    // Totality, asserted rather than assumed: an unhandled event in a live state
    // is exactly how a task ends up stuck.
    const events: ReadonlyArray<BackgroundTaskEvent> = [
      progress(),
      { type: "STOP_REQUESTED" },
      { type: "ABSENT", now: LATER },
      { type: "ORPHANED", now: LATER },
      settled("completed")
    ]
    for (const first of [[] as ReadonlyArray<BackgroundTaskEvent>, [{ type: "STOP_REQUESTED" } as const]]) {
      for (const event of events) {
        const snapshot = drive([...first, event])
        expect(["running", "stopping", "completed", "stopped", "failed"]).toContain(snapshot.value)
      }
    }
  })
})

describe("toBackgroundTask", () => {
  it("projects a snapshot onto the wire DTO", () => {
    const actor = start({ subagentType: "Explore", toolUseId: "toolu_1" })
    actor.send(progress())
    const snapshot = actor.getSnapshot()
    expect(toBackgroundTask(snapshot.value as "running", snapshot.context)).toStrictEqual({
      id: "t1",
      sessionId: "s1",
      description: "still going",
      taskType: "bash",
      subagentType: "Explore",
      status: "running",
      toolUseId: "toolu_1",
      tokens: 4200,
      toolUses: 7,
      durationMs: 31_000,
      lastTool: "Bash",
      summary: null,
      outputFile: null,
      startedAt: NOW,
      endedAt: null
    })
  })

  it("carries `stopping` onto the wire so the dock can show it", () => {
    const actor = start()
    actor.send({ type: "STOP_REQUESTED" })
    const snapshot = actor.getSnapshot()
    expect(toBackgroundTask(snapshot.value as "stopping", snapshot.context).status).toBe("stopping")
  })
})
