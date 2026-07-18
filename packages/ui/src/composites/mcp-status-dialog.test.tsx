import type { McpServer, McpServerStatus } from "@starbase/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fmtChecked, McpStatusDialog } from "./mcp-status-dialog.js"
import { mcpServerMeta } from "./mcp-server-row.js"

/**
 * The composer's MCP dialog is the one surface with a session, so it's the only
 * place project and local scope can be shown. It must group by scope, surface
 * failures plainly, and never render a secret.
 */

afterEach(cleanup)

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: "linear",
  cli: "claude",
  transport: "stdio",
  scope: "user",
  target: "npx -y @linear/mcp",
  envKeys: [],
  headerKeys: [],
  enabled: true,
  ...over
})

const status = (over: Partial<McpServerStatus> = {}): McpServerStatus => ({
  name: "linear",
  scope: "user",
  state: "connected",
  toolCount: 6,
  error: null,
  checkedAt: "2026-07-18T00:00:00.000Z",
  ...over
})

const open = (props: Partial<React.ComponentProps<typeof McpStatusDialog>> = {}) =>
  render(<McpStatusDialog open cli="claude" servers={[]} statuses={[]} {...props} />)

describe("McpStatusDialog", () => {
  it("names the harness in the empty state so the operator knows where to look", () => {
    open({ cli: "codex" })
    expect(screen.getByText(/codex has no MCP servers configured/i)).toBeTruthy()
  })

  it("lists servers grouped by scope", () => {
    open({
      servers: [server({ name: "userSrv" }), server({ name: "projSrv", scope: "project" })]
    })
    expect(screen.getByText("User")).toBeTruthy()
    expect(screen.getByText("Project")).toBeTruthy()
    expect(screen.getByText("userSrv")).toBeTruthy()
    expect(screen.getByText("projSrv")).toBeTruthy()
  })

  /** Precedence order, so the most specific scope reads first. */
  it("orders scopes local, then project, then user", () => {
    open({
      servers: [
        server({ name: "u" }),
        server({ name: "p", scope: "project" }),
        server({ name: "l", scope: "local" })
      ]
    })
    const headings = screen.getAllByText(/^(This machine|Project|User)$/).map((el) => el.textContent)
    expect(headings).toStrictEqual(["This machine", "Project", "User"])
  })

  it("omits a scope heading when nothing is in that scope", () => {
    open({ servers: [server()] })
    expect(screen.queryByText("Project")).toBeNull()
    expect(screen.queryByText("This machine")).toBeNull()
  })

  it("shows the tool count for a connected server", () => {
    open({ servers: [server()], statuses: [status()] })
    expect(screen.getByText(/6 tools/)).toBeTruthy()
  })

  it("warns when servers failed, saying what the agent loses", () => {
    open({ servers: [server()], statuses: [status({ state: "failed", toolCount: null, error: "boom" })] })
    expect(screen.getByText(/1 server didn't respond/i)).toBeTruthy()
    expect(screen.getByText(/run without its tools/i)).toBeTruthy()
  })

  it("pluralises the failure warning", () => {
    open({
      servers: [server({ name: "a" }), server({ name: "b" })],
      statuses: [
        status({ name: "a", state: "failed", toolCount: null, error: "x" }),
        status({ name: "b", state: "failed", toolCount: null, error: "y" })
      ]
    })
    expect(screen.getByText(/2 servers didn't respond/i)).toBeTruthy()
  })

  it("shows no warning when everything connected", () => {
    open({ servers: [server()], statuses: [status()] })
    expect(screen.queryByText(/didn't respond/i)).toBeNull()
  })

  /** Same name in two scopes is legal; statuses must not cross-match. */
  it("matches status to the right scope when a name appears twice", () => {
    open({
      servers: [server({ name: "dup" }), server({ name: "dup", scope: "project" })],
      statuses: [
        status({ name: "dup", scope: "user", toolCount: 1 }),
        status({ name: "dup", scope: "project", state: "failed", toolCount: null, error: "project failed" })
      ]
    })
    expect(screen.getByText(/1 tools/)).toBeTruthy()
    expect(screen.getByText(/project failed/)).toBeTruthy()
  })

  it("refreshes on demand", () => {
    const onRefresh = vi.fn()
    open({ servers: [server()], onRefresh })
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("disables refresh while a probe is in flight", () => {
    open({ servers: [server()], onRefresh: vi.fn(), loading: true })
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/Checking servers/i)).toBeTruthy()
  })

  it("says when it has never checked", () => {
    open({ servers: [server()], checkedAt: null })
    expect(screen.getByText(/not checked yet/i)).toBeTruthy()
  })

  /**
   * "off" means the harness won't load the server. A server whose PROBE failed is
   * still loaded — the agent just runs without its tools, which is exactly what the
   * Callout above says. Rendering it "off" made the row contradict the Callout.
   */
  it("keeps a failed server marked on, not off, and flags it unreachable", () => {
    open({ servers: [server()], statuses: [status({ state: "failed", toolCount: null, error: "boom" })] })
    expect(screen.getByText("unreachable")).toBeTruthy()
    expect(screen.queryByText("off")).toBeNull()
  })

  it("marks a server the harness won't load as off", () => {
    open({ servers: [server({ enabled: false })] })
    expect(screen.getByText("off")).toBeTruthy()
    expect(screen.queryByText("unreachable")).toBeNull()
  })

  /** An un-gated project server is listed but deliberately never contacted. */
  it("shows an un-probed project server as not checked, explaining why", () => {
    open({
      servers: [server({ name: "proj", scope: "project", cli: "cursor" })],
      statuses: [status({ name: "proj", scope: "project", state: "unknown", toolCount: null })]
    })
    expect(screen.getByText("not checked")).toBeTruthy()
    expect(screen.getByText(/approve it in the harness first/)).toBeTruthy()
  })

  it("does not count an un-probed server as a failure", () => {
    open({
      servers: [server({ name: "proj", scope: "project" })],
      statuses: [status({ name: "proj", scope: "project", state: "unknown", toolCount: null })]
    })
    expect(screen.queryByText(/didn't respond/i)).toBeNull()
  })

  it("renders env key names but never a value", () => {
    open({ servers: [server({ envKeys: ["LINEAR_API_KEY"] })] })
    expect(screen.getByText(/LINEAR_API_KEY/)).toBeTruthy()
    expect(document.body.textContent).not.toContain("sk-live")
  })
})

describe("mcpServerMeta — dialog variant (no scope prefix)", () => {
  it("leads with the failure reason", () => {
    expect(mcpServerMeta(server(), status({ state: "failed", toolCount: null, error: "spawn ENOENT" }))).toContain(
      "spawn ENOENT"
    )
  })

  it("marks a server the harness won't load", () => {
    expect(mcpServerMeta(server({ enabled: false }))).toContain("not enabled")
  })

  it("falls back to the target before any probe", () => {
    expect(mcpServerMeta(server())).toBe("npx -y @linear/mcp")
  })
})

describe("fmtChecked", () => {
  it("reads as never checked for null", () => {
    expect(fmtChecked(null)).toBe("not checked yet")
  })

  it("reads as just now for a fresh probe", () => {
    expect(fmtChecked(new Date().toISOString())).toBe("checked just now")
  })

  /** Delegates to the repo's shared `relativeTime`, hence "5m" not "5 min". */
  it("reads in minutes for an older probe, in the repo's dialect", () => {
    expect(fmtChecked(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("checked 5m ago")
  })
})
