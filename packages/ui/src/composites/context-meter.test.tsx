import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ContextMeter } from "./context-meter.js"

afterEach(cleanup)

/**
 * The meter's job is to make the QUALITY BUDGET legible, not the hard window.
 * Every test here is really about that distinction.
 */
describe("ContextMeter", () => {
  it("measures against the compaction trigger, not the model's ceiling", () => {
    // A 1M-window model at 300k. Against the window this is 30% — against the
    // point where quality goes, it is full. Full is the honest reading.
    const { container } = render(<ContextMeter tokens={300_000} triggerAt={300_000} />)
    const bar = container.querySelector("span[style]") as HTMLElement
    expect(bar.style.width).toBe("100%")
  })

  it("fills proportionally below the trigger", () => {
    const { container } = render(<ContextMeter tokens={85_000} triggerAt={170_000} />)
    const bar = container.querySelector("span[style]") as HTMLElement
    expect(bar.style.width).toBe("50%")
  })

  it("never overflows past full when the session runs over", () => {
    const { container } = render(<ContextMeter tokens={900_000} triggerAt={300_000} />)
    const bar = container.querySelector("span[style]") as HTMLElement
    expect(bar.style.width).toBe("100%")
  })

  /**
   * An empty bar reads as "plenty of room left", which is the opposite of the
   * truth for a harness we cannot measure at all. Rendering nothing is honest.
   */
  it("renders nothing when the harness cannot report context", () => {
    const { container } = render(<ContextMeter tokens={100_000} triggerAt={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing before the first reading", () => {
    const { container } = render(<ContextMeter tokens={0} triggerAt={170_000} />)
    expect(container.firstChild).toBeNull()
  })

  it("says a compaction is coming once over the trigger", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} />)
    expect(screen.getByText("compacting soon")).toBeDefined()
  })

  it("says the next turn will reseed once a digest is ready", () => {
    render(<ContextMeter tokens={310_000} triggerAt={300_000} digestReady />)
    expect(screen.getByText("compacting next turn")).toBeDefined()
  })

  // Crossing the trigger is the system WORKING — a digest is being prepared and
  // the next turn will be cheaper. Red would train the user to intervene in
  // something that handles itself.
  it("never uses an alarm colour, even when full", () => {
    const { container } = render(<ContextMeter tokens={900_000} triggerAt={300_000} />)
    expect(container.innerHTML).not.toContain("red")
  })

  it("explains the numbers on hover", () => {
    const { container } = render(<ContextMeter tokens={150_000} triggerAt={170_000} />)
    const title = (container.firstChild as HTMLElement).getAttribute("title")
    expect(title).toContain("150,000")
    expect(title).toContain("170,000")
    expect(title).toContain("compacts")
  })
})
