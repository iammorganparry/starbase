import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChipMenu } from "./chip-menu.js"

/**
 * The model list grows with every harness and every model a provider ships, so
 * the model chip filters. These cover what the operator does: type part of a
 * model, or type a harness when they just want "whatever Codex has".
 */

afterEach(cleanup)

const groups = [
  {
    label: "Claude Code",
    options: [
      { value: "claude:opus", label: "opus" },
      { value: "claude:sonnet", label: "sonnet" },
      { value: "claude:haiku", label: "haiku" }
    ]
  },
  {
    label: "Codex CLI",
    options: [
      { value: "codex:gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { value: "codex:gpt-5.6-terra", label: "GPT-5.6-Terra" }
    ]
  }
]

const open = () => fireEvent.pointerDown(screen.getByRole("button"), { button: 0, ctrlKey: false })
const box = () => screen.getByRole("textbox")
const items = () => screen.queryAllByRole("menuitem").map((n) => n.textContent)

describe("ChipMenu search", () => {
  it("has no filter box unless asked for (the mode chip stays plain)", () => {
    render(<ChipMenu value="claude:opus" groups={groups} />)
    open()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("filters to a model by name", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "haiku" } })
    expect(items()).toEqual(["haiku"])
  })

  it("filters by harness name, so you can ask for a provider not a model", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "codex" } })
    // Every Codex model, and nothing from Claude.
    expect(items()).toEqual(["GPT-5.6-Sol", "GPT-5.6-Terra"])
  })

  it("is case-insensitive and matches partial text", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "TERRA" } })
    expect(items()).toEqual(["GPT-5.6-Terra"])
  })

  it("says so when nothing matches, rather than showing an empty menu", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable emptyLabel="No models match" />)
    open()
    fireEvent.change(box(), { target: { value: "zzzz" } })
    expect(items()).toEqual([])
    expect(screen.getByText("No models match")).toBeDefined()
  })

  it("selects the top match on Enter, emitting the full value", () => {
    const onSelect = vi.fn()
    render(<ChipMenu value="claude:opus" groups={groups} searchable onSelect={onSelect} />)
    open()
    fireEvent.change(box(), { target: { value: "sol" } })
    fireEvent.keyDown(box(), { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("codex:gpt-5.6-sol")
  })

  it("keeps section headings while filtered, so a model still names its harness", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "terra" } })
    // Filtering to one group must not drop the heading — you'd lose which
    // harness you're about to switch to.
    expect(screen.getByText("Codex CLI")).toBeDefined()
    expect(screen.queryByText("Claude Code")).toBeNull()
  })

  it("forgets the filter once closed, so reopening shows the whole list", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "haiku" } })
    expect(items()).toEqual(["haiku"])
    fireEvent.keyDown(box(), { key: "Escape" })
    open()
    expect(items()).toHaveLength(5)
  })

  it("still shows the selected label on the chip", () => {
    render(<ChipMenu value="codex:gpt-5.6-sol" groups={groups} searchable />)
    expect(screen.getByRole("button").textContent).toContain("GPT-5.6-Sol")
  })
})

describe("ChipMenu search — keyboard, against Radix's own handling", () => {
  it("takes focus on open, so you can just start typing", async () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    // Radix focuses the menu itself on open; we claim the caret a frame later.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(document.activeElement).toBe(box())
  })

  /**
   * Radix's menu implements typeahead: a bare letter key jumps focus to the item
   * it matches, which inside a filter box would rip the caret away mid-word. The
   * guard is to stop ordinary keystrokes reaching the menu, while letting the
   * ones that MEAN "navigate the menu" through.
   *
   * We assert on propagation rather than on focus moving, because jsdom doesn't
   * reproduce Radix's typeahead focus change (verified) — a focus assertion here
   * would pass whether or not the guard exists. Radix's own handler is a React
   * onKeyDown in this same synthetic tree, so a spy on an ancestor stands in for
   * it exactly: portalled content still propagates through the React tree.
   */
  const keysReachingTheMenu = () => {
    const spy = vi.fn()
    render(
      <div onKeyDown={(e) => spy(e.key)}>
        <ChipMenu value="claude:opus" groups={groups} searchable />
      </div>
    )
    open()
    return spy
  }

  it("keeps ordinary typing out of Radix's typeahead", () => {
    const spy = keysReachingTheMenu()
    fireEvent.keyDown(box(), { key: "s" })
    expect(spy).not.toHaveBeenCalled()
  })

  it("still lets arrow keys through, so you can move into the list", () => {
    const spy = keysReachingTheMenu()
    fireEvent.keyDown(box(), { key: "ArrowDown" })
    expect(spy).toHaveBeenCalledWith("ArrowDown")
  })

  it("leaves Escape to Radix, so the menu still closes from the filter", async () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.keyDown(box(), { key: "Escape" })
    expect(screen.queryByRole("textbox")).toBeNull()
  })
})
