import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message } from "@starbase/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConversationView } from "./conversation-view.js"

afterEach(cleanup)

const intake: Message = {
  id: "u_1",
  role: "user",
  parts: [{ _tag: "Text", text: "Preserve the active filters." }],
  streaming: false,
  createdAt: "2026-07-23T12:00:00.000Z"
}

describe("Gigaplan handoff", () => {
  it("waits for intake context before enabling Create plan", () => {
    const onHandoffPlan = vi.fn()
    const { rerender } = render(
      <ConversationView
        messages={[]}
        mode="gigaplan"
        adversarialPlanning={{ ready: true, reason: null }}
        onHandoffPlan={onHandoffPlan}
      />
    )

    const emptyButton = screen.getByRole("button", { name: "Create plan" })
    expect(emptyButton.hasAttribute("disabled")).toBe(true)
    expect(emptyButton.getAttribute("title")).toBe(
      "Send a Gigaplan message before creating a plan."
    )
    fireEvent.click(emptyButton)
    expect(onHandoffPlan).not.toHaveBeenCalled()

    rerender(
      <ConversationView
        messages={[intake]}
        mode="gigaplan"
        adversarialPlanning={{ ready: true, reason: null }}
        onHandoffPlan={onHandoffPlan}
      />
    )

    const readyButton = screen.getByRole("button", { name: "Create plan" })
    expect(readyButton.hasAttribute("disabled")).toBe(false)
    fireEvent.click(readyButton)
    expect(onHandoffPlan).toHaveBeenCalledOnce()
  })
})
