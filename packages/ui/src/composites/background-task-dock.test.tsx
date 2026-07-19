import type { BackgroundTask } from "@starbase/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackgroundTaskDock } from "./background-task-dock.js"

afterEach(cleanup)

/**
 * The dock exists because background work used to be invisible: an agent could
 * background a shell command or a sub-agent and it would run to completion with
 * nothing in the UI to say it existed, let alone stop it. So the behaviours that
 * matter are (1) live work is always visible and actionable, (2) the Stop button
 * visibly acknowledges a click that the harness confirms only later, and (3) the
 * dock stays out of the way when there is nothing to report.
 */

const task = (over: Partial<BackgroundTask> & { id: string }): BackgroundTask => ({
  sessionId: "s1",
  description: `task ${over.id}`,
  taskType: "bash",
  subagentType: null,
  status: "running",
  toolUseId: null,
  tokens: 0,
  toolUses: 0,
  durationMs: 0,
  lastTool: null,
  summary: null,
  outputFile: null,
  startedAt: "2026-07-18T12:00:00.000Z",
  endedAt: null,
  ...over
})

/**
 * The dock mounts COLLAPSED (it would otherwise sit over the composer), so any
 * assertion about rows has to open it first. Tests that assert on the header —
 * counts, the empty/unsupported cases — deliberately don't call this.
 */
const expand = () =>
  fireEvent.click(screen.getByRole("button", { name: /expand background tasks/i }))

const rowOrder = () =>
  Array.from(document.querySelectorAll("[data-testid^='bg-task-']")).map((el) =>
    el.getAttribute("data-testid")!.replace("bg-task-", "")
  )

describe("BackgroundTaskDock", () => {
  it("lists a running task with its live progress", () => {
    render(
      <BackgroundTaskDock
        tasks={[task({ id: "t1", description: "run the suite", durationMs: 92_000, toolUses: 7, tokens: 4200, lastTool: "Bash" })]}
      />
    )
    expand()
    expect(screen.getByText("run the suite")).toBeDefined()
    expect(screen.getByText("Running")).toBeDefined()
    expect(screen.getByText("1m 32s")).toBeDefined()
    expect(screen.getByText("7 tools")).toBeDefined()
    expect(screen.getByText("4.2k tokens")).toBeDefined()
    expect(screen.getByText("Bash")).toBeDefined()
  })

  it("renders nothing when there is nothing to report", () => {
    // An empty dock is chrome that costs attention and says nothing.
    render(<BackgroundTaskDock tasks={[]} />)
    expect(screen.queryByTestId("background-task-dock")).toBeNull()
  })

  it("renders nothing for a harness with no background-task support", () => {
    // Codex and opencode can only abort a whole turn. Showing a dock with a Stop
    // button that cannot target anything would be a lie.
    render(<BackgroundTaskDock supported={false} tasks={[task({ id: "t1" })]} />)
    expect(screen.queryByTestId("background-task-dock")).toBeNull()
  })

  it("puts running tasks above finished ones", () => {
    // Live work is what you act on, so it must never be pushed below history.
    render(
      <BackgroundTaskDock
        tasks={[
          task({ id: "done", status: "completed", endedAt: "2026-07-18T12:09:00.000Z" }),
          task({ id: "live" })
        ]}
      />
    )
    expand()
    expect(rowOrder()).toStrictEqual(["live", "done"])
  })

  it("orders finished tasks most-recent-first", () => {
    render(
      <BackgroundTaskDock
        tasks={[
          task({ id: "older", status: "completed", endedAt: "2026-07-18T12:01:00.000Z" }),
          task({ id: "newer", status: "completed", endedAt: "2026-07-18T12:09:00.000Z" })
        ]}
      />
    )
    expand()
    expect(rowOrder()).toStrictEqual(["newer", "older"])
  })

  it("stops a running task by its id", () => {
    const onStop = vi.fn()
    render(<BackgroundTaskDock tasks={[task({ id: "t1", description: "long build" })]} onStop={onStop} />)
    expand()
    fireEvent.click(screen.getByRole("button", { name: /stop long build/i }))
    expect(onStop).toHaveBeenCalledWith("t1")
  })

  it("acknowledges a stop that the harness has not confirmed yet", () => {
    // THE reason `stopping` is a first-class state: the harness confirms
    // asynchronously, so without this the row looks untouched after the click and
    // invites a second one.
    render(<BackgroundTaskDock tasks={[task({ id: "t1", status: "stopping" })]} onStop={vi.fn()} />)
    expand()
    const button = screen.getByRole("button", { name: /stop task t1/i })
    expect(button.textContent).toContain("Stopping")
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it("offers no Stop for a task that has already finished", () => {
    render(<BackgroundTaskDock tasks={[task({ id: "t1", status: "completed" })]} onStop={vi.fn()} />)
    expand()
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull()
  })

  it("offers View only once a transcript exists", () => {
    const onView = vi.fn()
    render(
      <BackgroundTaskDock
        tasks={[
          task({ id: "running-no-file" }),
          task({ id: "done-no-file", status: "completed" }),
          task({ id: "done", status: "completed", outputFile: "/tmp/t.jsonl" })
        ]}
        onView={onView}
      />
    )
    expand()
    // A running task has no output_file yet — the harness only reports one on settle.
    expect(screen.getAllByRole("button", { name: /view output/i })).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /view output/i }))
    expect(onView).toHaveBeenCalledWith("done")
  })

  it("shows the summary instead of live counters once settled", () => {
    render(
      <BackgroundTaskDock
        tasks={[task({ id: "t1", status: "completed", summary: "found 3 flaky tests", toolUses: 9 })]}
      />
    )
    expand()
    expect(screen.getByText("found 3 flaky tests")).toBeDefined()
    expect(screen.queryByText("9 tools")).toBeNull()
  })

  it("counts only live tasks in the running badge", () => {
    render(
      <BackgroundTaskDock
        tasks={[
          task({ id: "a" }),
          task({ id: "b", status: "stopping" }),
          task({ id: "c", status: "completed" })
        ]}
      />
    )
    expect(screen.getByText("2 running")).toBeDefined()
    expect(screen.getByText("3")).toBeDefined()
  })

  it("mounts collapsed, even with live work", () => {
    // The dock sits directly above the composer, so an expanded default crowds
    // the thing the operator is actually typing into. The header badges carry the
    // signal instead; opening it is their move.
    render(<BackgroundTaskDock tasks={[task({ id: "t1" })]} />)
    expect(rowOrder()).toStrictEqual([])
    expect(screen.getByText("1 running")).toBeDefined()
  })

  it("expands and collapses without losing the rows", () => {
    render(<BackgroundTaskDock tasks={[task({ id: "t1" })]} />)
    expand()
    expect(rowOrder()).toStrictEqual(["t1"])
    fireEvent.click(screen.getByRole("button", { name: /collapse background tasks/i }))
    expect(rowOrder()).toStrictEqual([])
  })

  it("offers dismiss for a failed task only", () => {
    // Everything else ages out of the registry on its own; a failure is held so
    // it can't go unseen, which makes this the only way to clear one.
    const onDismiss = vi.fn()
    render(
      <BackgroundTaskDock
        tasks={[task({ id: "bad", status: "failed" }), task({ id: "ok", status: "completed" })]}
        onDismiss={onDismiss}
      />
    )
    expand()
    expect(screen.getAllByRole("button", { name: /dismiss/i })).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledWith("bad")
  })
})
