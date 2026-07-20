import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_DND_MIME } from "./layout-grid.js"
import { SessionGrid } from "./session-grid.js"
import { SessionRow } from "../composites/session-row.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)

const sessions = [session({ id: "a" }), session({ id: "b" })]

/**
 * jsdom has no real drag-and-drop, so the payload is modelled explicitly: a map
 * of MIME → value, exposing the same `types` / `getData` surface the handlers
 * actually use. `types` is the important half — the dragover path can only read
 * that one.
 */
const transfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (mime: string) => data[mime] ?? "",
  setData: vi.fn(),
  dropEffect: "",
  effectAllowed: ""
})

const sessionDrag = (id: string) => transfer({ [SESSION_DND_MIME]: id })

describe("dragging a session onto a slot", () => {
  it("assigns the dropped session to the slot it landed on", () => {
    const onAssignSlot = vi.fn()
    render(
      <SessionGrid
        layout={{ mode: "1|1", slots: ["a", null], focused: 0 }}
        sessions={sessions}
        onFocusSlot={vi.fn()}
        onAssignSlot={onAssignSlot}
        renderConversation={(s) => <div>transcript {s.id}</div>}
      />
    )
    fireEvent.drop(screen.getByTestId("grid-slot-1"), { dataTransfer: sessionDrag("b") })
    expect(onAssignSlot).toHaveBeenCalledWith(1, "b")
  })

  it("ignores a drag that is not one of our sessions", () => {
    // The composer accepts file drops; a slot must not swallow one.
    const onAssignSlot = vi.fn()
    render(
      <SessionGrid
        layout={{ mode: "1|1", slots: ["a", null], focused: 0 }}
        sessions={sessions}
        onFocusSlot={vi.fn()}
        onAssignSlot={onAssignSlot}
        renderConversation={(s) => <div>transcript {s.id}</div>}
      />
    )
    const files = transfer({ "text/plain": "hello", Files: "" })
    fireEvent.dragOver(screen.getByTestId("grid-slot-1"), { dataTransfer: files })
    fireEvent.drop(screen.getByTestId("grid-slot-1"), { dataTransfer: files })
    expect(onAssignSlot).not.toHaveBeenCalled()
  })

  it("highlights only the slot under the pointer", () => {
    render(
      <SessionGrid
        layout={{ mode: "2|2", slots: ["a", null, null, null], focused: 0 }}
        sessions={sessions}
        onFocusSlot={vi.fn()}
        onAssignSlot={vi.fn()}
        renderConversation={(s) => <div>transcript {s.id}</div>}
      />
    )
    fireEvent.dragOver(screen.getByTestId("grid-slot-2"), { dataTransfer: sessionDrag("b") })
    expect(screen.getByTestId("grid-slot-2").className).toContain("ring-blue")
    expect(screen.getByTestId("grid-slot-1").className).not.toContain("ring-2")
  })

  it("does not accept drops when the grid is read-only", () => {
    render(
      <SessionGrid
        layout={{ mode: "1|1", slots: ["a", null], focused: 0 }}
        sessions={sessions}
        onFocusSlot={vi.fn()}
        renderConversation={(s) => <div>transcript {s.id}</div>}
      />
    )
    fireEvent.dragOver(screen.getByTestId("grid-slot-1"), { dataTransfer: sessionDrag("b") })
    expect(screen.getByTestId("grid-slot-1").className).not.toContain("ring-2")
  })
})

describe("SessionRow as a drag source", () => {
  it("puts the session id on the drag under our own MIME type", () => {
    const dataTransfer = transfer({})
    render(<SessionRow session={session({ id: "a" })} />)
    fireEvent.dragStart(screen.getByTestId("session-row-a"), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith(SESSION_DND_MIME, "a")
  })

  it("badges a row that occupies a slot, 1-based for display", () => {
    render(<SessionRow session={session({ id: "a" })} slotIndex={2} />)
    expect(screen.getByTestId("session-slot-badge-a").textContent).toBe("3")
  })

  it("shows no badge for a session that is not on the grid", () => {
    render(<SessionRow session={session({ id: "a" })} slotIndex={null} />)
    expect(screen.queryByTestId("session-slot-badge-a")).toBeNull()
  })

  it("badges an archived row too", () => {
    render(<SessionRow session={session({ id: "a", archived: true })} slotIndex={0} />)
    expect(screen.getByTestId("session-slot-badge-a").textContent).toBe("1")
  })
})
