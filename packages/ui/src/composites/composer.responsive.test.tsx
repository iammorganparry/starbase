import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { Composer } from "./composer.js"

afterEach(cleanup)

const renderAt = (width: number, props: Partial<React.ComponentProps<typeof Composer>> = {}) =>
  render(
    <WidthTierValue width={width}>
      <Composer {...props} />
    </WidthTierValue>
  )

describe("Composer at width", () => {
  it("keeps decorative keyboard hints out even when there is room", () => {
    renderAt(1000)
    expect(screen.queryByText("/ · @ · paste image")).toBeNull()
  })

  it("keeps Send and thinking visible at every width", () => {
    // The primary action is `flex-none` and last in DOM order precisely so a
    // squeeze wraps the chips above it rather than pushing it past the border.
    for (const width of [1200, 700, 450, 320]) {
      cleanup()
      renderAt(width)
      expect(screen.getByRole("button", { name: /Send/ })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Thinking strength" })).toBeTruthy()
    }
  })

  it("shortens the MCP label without losing the failure count", () => {
    renderAt(450, { mcp: { total: 3, failed: 1, probed: true } })
    const chip = screen.getByTitle("MCP server status")
    expect(chip.textContent).toContain("1/3")
    expect(chip.textContent).not.toContain("down")
  })

  it("keeps the MCP chip findable by the same name at any width", () => {
    // The NAME is constant while the label shortens — what a control IS must not
    // change with what it currently reports.
    renderAt(1200, { mcp: { total: 3, failed: 1, probed: true } })
    expect(screen.getByTitle("MCP server status").textContent).toContain("1 of 3 MCP down")
  })
})
