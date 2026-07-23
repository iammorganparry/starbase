import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)

describe("Composer thinking strength", () => {
  it("shows the native harness default until the session overrides it", () => {
    render(<Composer />)
    expect(screen.getByRole("button", { name: "Thinking strength" }).textContent).toContain(
      "default"
    )
  })

  it("reports a semantic strength and can restore the default", () => {
    const onSetReasoning = vi.fn()
    const { rerender } = render(
      <Composer reasoningEffort="think" onSetReasoning={onSetReasoning} />
    )

    fireEvent.pointerDown(screen.getByRole("button", { name: "Thinking strength" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "ultrathink" }))
    expect(onSetReasoning).toHaveBeenCalledWith("ultrathink")

    rerender(<Composer reasoningEffort="think" onSetReasoning={onSetReasoning} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Thinking strength" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "default" }))
    expect(onSetReasoning).toHaveBeenLastCalledWith(undefined)
  })

  it("offers an explicit plan handoff only in Gigaplan", () => {
    const onHandoffPlan = vi.fn()
    const { rerender } = render(
      <Composer
        mode="gigaplan"
        hasGigaplanIntake
        adversarialPlanning={{ ready: true, reason: null }}
        onHandoffPlan={onHandoffPlan}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Create plan" }))
    expect(onHandoffPlan).toHaveBeenCalledOnce()

    rerender(
      <Composer
        mode="gigaplan"
        hasGigaplanIntake
        hasPlan
        adversarialPlanning={{ ready: true, reason: null }}
        onHandoffPlan={onHandoffPlan}
      />
    )
    expect(screen.getByRole("button", { name: "Update plan" })).toBeTruthy()

    rerender(
      <Composer
        mode="accept-edits"
        adversarialPlanning={{ ready: true, reason: null }}
        onHandoffPlan={onHandoffPlan}
      />
    )
    expect(screen.queryByRole("button", { name: /plan/i })).toBeNull()
  })
})
