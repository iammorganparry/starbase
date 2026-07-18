import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

/**
 * The composer's MCP chip. Its whole job is to be honest: it must not appear
 * before we know anything, and must not claim health we haven't checked.
 */

afterEach(cleanup)

describe("Composer — MCP chip", () => {
  /**
   * Status arrives a beat after mount (same as the model catalogue). Rendering
   * "0 MCP" in that window would tell the operator their servers are missing.
   */
  it("is hidden until the status has loaded", () => {
    render(<Composer />)
    expect(screen.queryByTitle("MCP server status")).toBeNull()
  })

  it("stays hidden when the harness has no MCP servers", () => {
    render(<Composer mcp={{ total: 0, failed: 0, probed: false }} />)
    expect(screen.queryByTitle("MCP server status")).toBeNull()
  })

  it("shows the server count once loaded", () => {
    render(<Composer mcp={{ total: 3, failed: 0, probed: false }} />)
    expect(screen.getByTitle("MCP server status").textContent).toContain("3 MCP")
  })

  /** Before a probe we know a count, not a health — so the chip must not read as green. */
  it("does not claim anything is down before a probe has run", () => {
    render(<Composer mcp={{ total: 3, failed: 0, probed: false }} />)
    expect(screen.getByTitle("MCP server status").textContent).not.toContain("down")
  })

  it("reports failures once probed", () => {
    render(<Composer mcp={{ total: 3, failed: 1, probed: true }} />)
    expect(screen.getByTitle("MCP server status").textContent).toContain("1 of 3 MCP down")
  })

  it("keeps showing the plain count when a probe found everything healthy", () => {
    render(<Composer mcp={{ total: 3, failed: 0, probed: true }} />)
    expect(screen.getByTitle("MCP server status").textContent).toContain("3 MCP")
  })

  it("opens the dialog when clicked", () => {
    const onOpenMcp = vi.fn()
    render(<Composer mcp={{ total: 2, failed: 0, probed: false }} onOpenMcp={onOpenMcp} />)
    fireEvent.click(screen.getByTitle("MCP server status"))
    expect(onOpenMcp).toHaveBeenCalledOnce()
  })
})
