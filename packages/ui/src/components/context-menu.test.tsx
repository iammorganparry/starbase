import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContextMenu, type ContextMenuItem } from "./context-menu.js"

afterEach(cleanup)

/** Right-click the trigger, which is how this menu is opened for real. */
const open = () => fireEvent.contextMenu(screen.getByTestId("trigger"))

const renderMenu = (items: ReadonlyArray<ContextMenuItem>) =>
  render(
    <ContextMenu items={items}>
      <button type="button" data-testid="trigger">
        row
      </button>
    </ContextMenu>
  )

/**
 * Rows built from DATA can repeat their labels.
 *
 * "Split with ▸" is one row per session, labelled with the session's title, and
 * titles are auto-generated and operator-editable — two sessions called "Fix
 * build" is an ordinary Tuesday. Keying those rows on the label handed React two
 * children with the same key.
 *
 * Two kinds of test below, and the distinction is deliberate. The console-error
 * ones FAIL against the label-keyed version — that is the regression. The
 * behavioural ones (both rows present, each with its own action) passed before
 * the fix too: React renders duplicate-keyed siblings anyway today. They are
 * here as guards, not as proof, because React documents duplicate sibling keys
 * as undefined behaviour — so what passes now is a property of this version and
 * not a promise. Pinning it means a future version that starts dropping a row
 * fails here rather than in somebody's split.
 */
describe("ContextMenu identity", () => {
  const duplicates = (first: () => void, second: () => void): ReadonlyArray<ContextMenuItem> => [
    { id: "s1", label: "Fix build", onSelect: first },
    { id: "s2", label: "Fix build", onSelect: second }
  ]

  it("renders BOTH rows when two share a label", () => {
    renderMenu(duplicates(vi.fn(), vi.fn()))
    open()
    expect(screen.getAllByText("Fix build")).toHaveLength(2)
  })

  it("gives each duplicate-labelled row its own action", () => {
    // A guard rather than a regression test — see the note above. Clicking the
    // second "Fix build" must split with the SECOND session, which is the thing
    // a key collision would be free to get wrong.
    const first = vi.fn()
    const second = vi.fn()
    renderMenu(duplicates(first, second))
    open()

    const rows = screen.getAllByText("Fix build")
    fireEvent.click(rows[1]!)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it("logs no duplicate-key error for repeated labels", () => {
    // THIS is the regression. React reports duplicate keys through console.error
    // and nothing else — no throw, and today no visible break in the happy path —
    // so watching the console is the only way to catch it at all.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    renderMenu(duplicates(vi.fn(), vi.fn()))
    open()

    const duplicateKeyWarnings = errors.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("same key"))
    )
    expect(duplicateKeyWarnings).toEqual([])
    errors.mockRestore()
  })

  it("still keys static items by their label, with no id needed", () => {
    renderMenu([
      { label: "Rename", onSelect: vi.fn() },
      { label: "Archive", onSelect: vi.fn(), separated: true }
    ])
    open()
    expect(screen.getByText("Rename")).toBeDefined()
    expect(screen.getByText("Archive")).toBeDefined()
  })
})

/**
 * The reported path: Arc's "Split with ▸" flyout, one row per session.
 *
 * Opened with ArrowRight on the focused trigger, which is how Radix opens a
 * submenu from the keyboard and the only route that works without a real
 * pointer.
 */
describe("ContextMenu submenu identity", () => {
  const splitWith = (first: () => void, second: () => void): ReadonlyArray<ContextMenuItem> => [
    {
      label: "Split with",
      onSelect: () => {},
      submenu: [
        { id: "s_one", label: "Fix build", onSelect: first },
        { id: "s_two", label: "Fix build", onSelect: second }
      ]
    }
  ]

  const openSubmenu = () => {
    open()
    const trigger = screen.getByRole("menuitem", { name: /Split with/ })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowRight" })
  }

  it("offers every session, even two sharing a title", () => {
    renderMenu(splitWith(vi.fn(), vi.fn()))
    openSubmenu()
    expect(screen.getAllByText("Fix build")).toHaveLength(2)
  })

  it("splits with the session that was actually clicked", () => {
    const first = vi.fn()
    const second = vi.fn()
    renderMenu(splitWith(first, second))
    openSubmenu()

    fireEvent.click(screen.getAllByText("Fix build")[1]!)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it("logs no duplicate-key error for the flyout either", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    renderMenu(splitWith(vi.fn(), vi.fn()))
    openSubmenu()

    expect(
      errors.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("same key"))
      )
    ).toEqual([])
    errors.mockRestore()
  })
})
