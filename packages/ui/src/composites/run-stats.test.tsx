import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { RunStats } from "./run-stats.js"

afterEach(cleanup)

describe("RunStats", () => {
  it("labels the token count as context size", () => {
    const { container } = render(<RunStats startedAt={null} tokens={42_600} busy={false} />)

    expect(screen.getByText("context tokens")).toBeDefined()
    expect(container.textContent).toBe("42.6k context tokens")
  })
})
