import type { Message, ToolCall as ToolCallModel } from "@starbase/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MessageTurn } from "./message-turn.js"

/**
 * What the operator needs off a tool card: which FILE is being written (the part
 * a long worktree path pushes out of view), and what a command actually printed.
 */

afterEach(cleanup)

const tool = (t: Partial<ToolCallModel>): Message => ({
  id: "a0",
  role: "assistant",
  streaming: false,
  createdAt: "2026-07-11T10:00:00.000Z",
  parts: [
    {
      _tag: "Tool",
      tool: {
        id: "t1",
        name: "Bash",
        target: "pnpm test",
        status: "success",
        meta: null,
        diff: null,
        preview: null,
        ...t
      } as ToolCallModel
    }
  ]
})

const LONG = "/Users/morganparry/starbase/worktrees/starbase/vivid-dijkstra/.changeset/stop-a-run-search-models-and-honest-plan-steps.md"

describe("tool card — the file being written", () => {
  it("shows the filename in full, however long the path", () => {
    render(<MessageTurn message={tool({ name: "Write", target: LONG })} />)
    // The filename is its own element, so CSS truncation of the directory can
    // never eat it — the failure this fixes showed ".../vivid-dijkstra/.changes…"
    // and cut the filename off entirely.
    expect(screen.getByText("stop-a-run-search-models-and-honest-plan-steps.md")).toBeDefined()
  })

  it("keeps the directory as context, dimmed", () => {
    render(<MessageTurn message={tool({ name: "Write", target: LONG })} />)
    expect(
      screen.getByText("/Users/morganparry/starbase/worktrees/starbase/vivid-dijkstra/.changeset/")
    ).toBeDefined()
  })

  it("does not split a command into directory and filename", () => {
    // A Bash target is a command; slicing it at the last "/" would be nonsense.
    // (Bash now renders a command widget, which prints the command across a
    // bright program + dimmed args — hence textContent rather than getByText.)
    const { container } = render(
      <MessageTurn message={tool({ name: "Bash", target: "pnpm --filter @starbase/ui test" })} />
    )
    expect(container.textContent).toContain("pnpm --filter @starbase/ui test")
  })
})

describe("tool card — expanding a call", () => {
  /*
   * A bash command with output we can't read renders the generic command widget
   * (W10), which keeps the plain card's bargain: a quiet one-liner until asked,
   * then the whole log.
   */
  it("reveals the output on click", () => {
    render(<MessageTurn message={tool({ name: "Bash", target: "./scripts/seed.sh", output: "seeded 8214 users" })} />)
    expect(screen.queryByText(/seeded 8214 users/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText(/seeded 8214 users/)).toBeDefined()
  })

  it("collapses again on a second click", () => {
    render(<MessageTurn message={tool({ output: "hello" })} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByRole("button", { expanded: true })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { expanded: true }))
    expect(screen.queryByText("hello")).toBeNull()
  })

  it("summarises the outcome without being opened", () => {
    // The collapsed row has to be worth reading on its own, or expanding is the
    // only way to learn anything and the transcript is just a list of commands.
    render(<MessageTurn message={tool({ name: "Bash", target: "./x.sh", output: "a\nb\nc", status: "success" })} />)
    expect(screen.getByText(/exit 0 · 3 lines/)).toBeDefined()
  })

  it("says so when a finished call printed nothing", () => {
    // Distinct from "we didn't capture it" — an empty body would read as a bug.
    render(<MessageTurn message={tool({ target: "true", status: "success" })} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText("No output.")).toBeDefined()
  })

  it("leaves an edit's card to its diff peek rather than a rival toggle", () => {
    render(
      <MessageTurn
        message={tool({ name: "Edit", target: "/repo/src/a.ts", preview: "+added a line", diff: { added: 1, removed: 0 } })}
      />
    )
    // The header must not become a toggle: the change is already on show.
    expect(screen.queryByRole("button", { expanded: false })).toBeNull()
    expect(screen.getByText(/added a line/)).toBeDefined()
  })
})
