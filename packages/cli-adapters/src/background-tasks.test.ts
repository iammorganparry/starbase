import type { StreamEvent } from "@starbase/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { BackgroundTaskStore } from "./background-tasks.js"

/**
 * The registry that makes background work visible and stoppable. It holds one
 * statechart per task and never decides a status itself — these tests pin the
 * translation from harness signals to machine events, and the two behaviours
 * that only exist here: a stop that reflects immediately, and a task orphaned
 * because no live harness process owns it any more.
 */

const run = <A>(effect: Effect.Effect<A, never, BackgroundTaskStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BackgroundTaskStore.Default)))

const started = (id: string, over: Partial<Extract<StreamEvent, { _tag: "BackgroundTaskStarted" }>> = {}) =>
  ({
    _tag: "BackgroundTaskStarted",
    id,
    description: `task ${id}`,
    taskType: "bash",
    subagentType: null,
    toolUseId: null,
    ...over
  }) satisfies StreamEvent

describe("BackgroundTaskStore", () => {
  it("has no tasks for an unknown session", async () => {
    expect(await run(BackgroundTaskStore.list("nope"))).toStrictEqual([])
  })

  it("records a started task as running", async () => {
    const tasks = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: "t1", sessionId: "s1", status: "running", description: "task t1" })
  })

  it("keeps sessions independent", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.ingest("s2", started("t2"))
        return [yield* BackgroundTaskStore.list("s1"), yield* BackgroundTaskStore.list("s2")] as const
      })
    )
    expect(a.map((t) => t.id)).toStrictEqual(["t1"])
    expect(b.map((t) => t.id)).toStrictEqual(["t2"])
  })

  it("settles a task the level no longer lists, with no bookend", async () => {
    // The harness can drop a settle entirely; the level is authoritative.
    const [task] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.ingest("s1", { _tag: "BackgroundTasksChanged", ids: [] })
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(task!.status).toBe("completed")
  })

  it("creates a placeholder for a live id it never saw start", async () => {
    const [task] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", { _tag: "BackgroundTasksChanged", ids: ["ghost"] })
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(task).toMatchObject({ id: "ghost", status: "running" })
  })

  it("moves a task to `stopping` immediately, before the harness confirms", async () => {
    // The stop handle here never resolves — exactly like a real harness that
    // confirms via a later bookend. The row must still reflect the click.
    const [returned, listed] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.registerStop("s1", () => new Promise<void>(() => {}))
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        const returned = yield* BackgroundTaskStore.stop("s1", "t1")
        return [returned, yield* BackgroundTaskStore.list("s1")] as const
      })
    )
    expect(returned?.status).toBe("stopping")
    expect(listed[0]!.status).toBe("stopping")
  })

  it("forwards the stop to the harness with the task id", async () => {
    const asked: string[] = []
    await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.registerStop("s1", async (taskId) => void asked.push(taskId))
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.stop("s1", "t1")
      })
    )
    expect(asked).toStrictEqual(["t1"])
  })

  it("survives a harness that rejects the stop, leaving the task stopping", async () => {
    // The authoritative outcome still arrives via the level or the bookend, so a
    // rejected request must not take down the caller or settle the row falsely.
    const [task] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.registerStop("s1", () => Promise.reject(new Error("nope")))
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.stop("s1", "t1")
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(task!.status).toBe("stopping")
  })

  it("marks a task stopped when no live harness owns it", async () => {
    // No registered handle means the process is gone, so the task is already
    // dead. Leaving it `stopping` would strand a row that can never settle.
    const returned = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        return yield* BackgroundTaskStore.stop("s1", "t1")
      })
    )
    expect(returned?.status).toBe("stopped")
  })

  it("returns null for an unknown task id", async () => {
    expect(await run(BackgroundTaskStore.stop("s1", "nope"))).toBeNull()
  })

  it("orphans tasks left running by a previous harness process", async () => {
    // The live set is per-process and nothing is emitted at startup, so a task
    // carried across a restart could never settle and its id would no longer
    // resolve to anything stoppable.
    const [task] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.registerStop("s1", async () => {})
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(task!.status).toBe("completed")
  })

  it("keeps settled tasks readable across a restart", async () => {
    const [task] = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.ingest("s1", {
          _tag: "BackgroundTaskSettled",
          id: "t1",
          status: "completed",
          summary: "done",
          outputFile: "/tmp/t1.jsonl"
        })
        yield* BackgroundTaskStore.registerStop("s1", async () => {})
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(task).toMatchObject({ status: "completed", summary: "done", outputFile: "/tmp/t1.jsonl" })
  })

  it("drops a deleted session's tasks entirely", async () => {
    const tasks = await run(
      Effect.gen(function* () {
        yield* BackgroundTaskStore.ingest("s1", started("t1"))
        yield* BackgroundTaskStore.clear("s1")
        return yield* BackgroundTaskStore.list("s1")
      })
    )
    expect(tasks).toStrictEqual([])
  })
})
