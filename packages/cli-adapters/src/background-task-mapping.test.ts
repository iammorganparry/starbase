import type { StreamEvent } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { backgroundTaskState, streamEventsFor } from "./claude-adapter.js"

/**
 * Mapping the harness's task signals onto background-task events.
 *
 * The rule that everything here defends: `background_tasks_changed` (the LEVEL
 * signal) decides what counts as a background task. `task_started` fires for
 * FOREGROUND tasks too — every synchronous sub-agent — so promoting off that
 * edge would fill the dock with ordinary delegated work that was never
 * backgrounded at all.
 */

const tools = () => new Map()

const run = (msgs: ReadonlyArray<Record<string, unknown>>) => {
  const bg = backgroundTaskState()
  const toolMemo = tools()
  const out: StreamEvent[] = []
  for (const msg of msgs) out.push(...streamEventsFor(msg as never, toolMemo, bg))
  return out
}

const taskStarted = (over: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: "task_1",
  description: "run the suite",
  ...over
})

const level = (tasks: ReadonlyArray<Record<string, unknown>>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks
})

const notification = (over: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_notification",
  task_id: "task_1",
  status: "completed",
  output_file: "/tmp/task_1.jsonl",
  summary: "all green",
  ...over
})

const tags = (events: ReadonlyArray<StreamEvent>) => events.map((e) => e._tag)

describe("background-task mapping", () => {
  it("does NOT promote a task that merely started — it may be foreground", () => {
    expect(run([taskStarted()])).toStrictEqual([])
  })

  it("promotes a task once the level lists it, using the remembered metadata", () => {
    const events = run([
      taskStarted({ subagent_type: "Explore", task_type: "subagent", tool_use_id: "toolu_9" }),
      level([{ task_id: "task_1", task_type: "subagent", description: "ignored" }])
    ])
    expect(tags(events)).toStrictEqual(["BackgroundTaskStarted", "BackgroundTasksChanged"])
    expect(events[0]).toMatchObject({
      id: "task_1",
      // The start edge's description wins: it is the richer of the two.
      description: "run the suite",
      taskType: "subagent",
      subagentType: "Explore",
      toolUseId: "toolu_9"
    })
  })

  it("promotes a task from the level alone when its start edge never arrived", () => {
    const events = run([level([{ task_id: "ghost", task_type: "bash", description: "npm run watch" }])])
    expect(events[0]).toMatchObject({
      _tag: "BackgroundTaskStarted",
      id: "ghost",
      description: "npm run watch",
      taskType: "bash"
    })
  })

  it("promotes each task exactly once, however often the level repeats it", () => {
    const events = run([
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      level([
        { task_id: "task_1", task_type: "bash", description: "a" },
        { task_id: "task_2", task_type: "bash", description: "b" }
      ])
    ])
    expect(tags(events).filter((t) => t === "BackgroundTaskStarted")).toHaveLength(2)
  })

  it("always emits the level itself, so membership stays authoritative", () => {
    const events = run([level([{ task_id: "a", task_type: "bash", description: "a" }]), level([])])
    const levels = events.filter((e) => e._tag === "BackgroundTasksChanged")
    expect(levels).toHaveLength(2)
    expect(levels[0]).toMatchObject({ ids: ["a"] })
    expect(levels[1]).toMatchObject({ ids: [] })
  })

  it("ignores progress for a task that was never backgrounded", () => {
    const events = run([
      taskStarted(),
      { type: "system", subtype: "task_progress", task_id: "task_1", description: "x", usage: {} }
    ])
    expect(events).toStrictEqual([])
  })

  it("maps progress for a live background task, including its usage", () => {
    const events = run([
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task_1",
        description: "compiling",
        last_tool_name: "Bash",
        usage: { total_tokens: 4200, tool_uses: 7, duration_ms: 31_000 }
      }
    ])
    expect(events.at(-1)).toStrictEqual({
      _tag: "BackgroundTaskProgress",
      id: "task_1",
      description: "compiling",
      tokens: 4200,
      toolUses: 7,
      durationMs: 31_000,
      lastTool: "Bash"
    })
  })

  it("settles a promoted task, carrying its summary and transcript path", () => {
    const events = run([
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      notification()
    ])
    expect(events.at(-1)).toMatchObject({
      _tag: "BackgroundTaskSettled",
      id: "task_1",
      status: "completed",
      summary: "all green",
      outputFile: "/tmp/task_1.jsonl"
    })
  })

  it("settles on the bookend even though the id has already left the live set", () => {
    // Keyed on "ever promoted", not "currently live" — the level routinely drops
    // a task before its bookend lands, and keying on `live` would silently skip
    // the settle and leave the row spinning.
    const events = run([
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      level([]),
      notification()
    ])
    expect(tags(events).at(-1)).toBe("BackgroundTaskSettled")
  })

  it("maps a stop to `stopped`, not `failed`", () => {
    // The operator's own kill is not an error to report.
    const events = run([
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      notification({ status: "stopped" })
    ])
    expect(events.at(-1)).toMatchObject({ status: "stopped" })
  })

  it("maps any other terminal status to `failed`", () => {
    const events = run([
      level([{ task_id: "task_1", task_type: "bash", description: "a" }]),
      notification({ status: "failed" })
    ])
    expect(events.at(-1)).toMatchObject({ status: "failed" })
  })

  it("emits no background events for a notification about a never-backgrounded task", () => {
    // Ordinary synchronous sub-agents still settle their TAB, and must not leave
    // a phantom row in the dock.
    const events = run([taskStarted(), notification({ tool_use_id: "toolu_1" })])
    expect(tags(events)).toStrictEqual(["SubagentEnded"])
  })

  it("settles a backgrounded sub-agent in the dock and NOT as a tab", () => {
    // A backgrounded sub-agent belongs to ONE surface. Its tab was opened at
    // tool_use time and retracted the moment the level signal revealed it was
    // backgrounded, so an accompanying `SubagentEnded` would address an id that
    // no longer exists — and would be the one place the pipeline still talks
    // about background work as if it were a tab.
    const events = run([
      taskStarted({ tool_use_id: "toolu_1", subagent_type: "Explore" }),
      level([{ task_id: "task_1", task_type: "subagent", description: "a" }]),
      notification({ tool_use_id: "toolu_1" })
    ])
    expect(tags(events).at(-1)).toBe("BackgroundTaskSettled")
    expect(tags(events)).not.toContain("SubagentEnded")
  })

  it("carries the spawning tool_use id, so the tab can be retracted", () => {
    // `toolUseId` is the join key between the dock row and the tab that must go.
    // Without it the renderer has no way to tell WHICH tab this task supersedes.
    const events = run([
      taskStarted({ tool_use_id: "toolu_1", subagent_type: "Explore" }),
      level([{ task_id: "task_1", task_type: "subagent", description: "a" }])
    ])
    expect(events[0]).toMatchObject({ _tag: "BackgroundTaskStarted", toolUseId: "toolu_1" })
  })

  it("emits nothing background-related when no state is threaded through", () => {
    // The transcript backfill calls `streamEventsFor` without it: background
    // tasks are session-level and have no place in a rebuilt message fold.
    const bgless = streamEventsFor(level([{ task_id: "a", task_type: "bash", description: "a" }]) as never, tools())
    expect(bgless).toStrictEqual([])
  })
})
