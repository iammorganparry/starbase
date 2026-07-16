import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChipMenu } from "./chip-menu.js"

/**
 * The model chip groups models under their harness so that picking a model also
 * picks a provider. These assert what the operator sees and does: the chip shows
 * the selected model's LABEL (never a raw composite value), sections are headed
 * only when there's a choice of harness, and selecting emits the full value.
 */

afterEach(cleanup)

const groups = [
  { label: "Claude Code", options: [{ value: "claude:opus", label: "opus" }] },
  {
    label: "Codex CLI",
    options: [
      { value: "codex:gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { value: "codex:gpt-5.5", label: "GPT-5.5" }
    ]
  }
]

const open = () => fireEvent.pointerDown(screen.getByRole("button"), { button: 0, ctrlKey: false })

describe("ChipMenu", () => {
  it("shows the selected option's label, not its value", () => {
    render(<ChipMenu value="codex:gpt-5.6-sol" groups={groups} />)
    expect(screen.getByRole("button").textContent).toContain("GPT-5.6-Sol")
    expect(screen.getByRole("button").textContent).not.toContain("codex:")
  })

  it("heads each section when more than one harness is offered", () => {
    render(<ChipMenu value="claude:opus" groups={groups} />)
    open()
    expect(screen.getByText("Claude Code")).toBeDefined()
    expect(screen.getByText("Codex CLI")).toBeDefined()
  })

  // With one harness installed, a lone heading is just noise above the models.
  it("omits the heading when only one harness is offered", () => {
    render(<ChipMenu value="claude:opus" groups={[groups[0]!]} />)
    open()
    expect(screen.queryByText("Claude Code")).toBeNull()
    // The models themselves are still listed (the chip also reads "opus", so
    // this asserts against the menu item rather than the text).
    expect(screen.getByRole("menuitem", { name: "opus" })).toBeDefined()
  })

  it("emits the full value so the caller can tell which harness was picked", () => {
    const onSelect = vi.fn()
    render(<ChipMenu value="claude:opus" groups={groups} onSelect={onSelect} />)
    open()
    fireEvent.click(screen.getByText("GPT-5.6-Sol"))
    expect(onSelect).toHaveBeenCalledWith("codex:gpt-5.6-sol")
  })

  it("still renders a flat list of options", () => {
    const onSelect = vi.fn()
    render(
      <ChipMenu
        value="ask"
        options={[
          { value: "ask", label: "ask" },
          { value: "auto", label: "auto" }
        ]}
        onSelect={onSelect}
      />
    )
    open()
    fireEvent.click(screen.getByText("auto"))
    expect(onSelect).toHaveBeenCalledWith("auto")
  })

  it("renders a bare chip with no menu when disabled", () => {
    render(<ChipMenu value="claude:opus" groups={groups} disabled />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("opus")).toBeDefined()
  })
})
