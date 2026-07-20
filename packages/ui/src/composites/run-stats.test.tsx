import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { RunStats } from "./run-stats.js"

afterEach(cleanup)

describe("RunStats", () => {
  it("renders nothing when there is no run", () => {
    const { container } = render(<RunStats startedAt={null} busy={false} />)

    expect(container.textContent).toBe("")
  })

  it("shows the elapsed time of a run", () => {
    const { container } = render(<RunStats startedAt={Date.now() - 45_000} busy />)

    expect(container.textContent).toContain("45s")
  })

  /**
   * The context reading belongs to `ContextMeter` alone. Both components render
   * side by side above the composer, so a token count here reappears as the
   * duplicate this was split to remove.
   */
  it("does not report context size", () => {
    render(<RunStats startedAt={Date.now() - 45_000} busy />)

    expect(screen.queryByText("context tokens")).toBeNull()
  })
})
