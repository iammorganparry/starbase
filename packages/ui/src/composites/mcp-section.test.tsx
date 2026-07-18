import type { CliInfo, McpServer, McpServerStatus } from "@starbase/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mcpRowMeta, SettingsView } from "./settings-view.js"

/**
 * Settings → MCP servers reflects the harness's OWN config. It is a mirror, not a
 * store, so there is nothing to save here — what matters is that it reads the right
 * harness, never leaks a secret, and only probes when asked.
 */

afterEach(cleanup)

const CLIS: ReadonlyArray<CliInfo> = [
  { kind: "claude", label: "Claude", available: true, version: "1.0.0", binPath: "/usr/bin/claude" },
  { kind: "codex", label: "Codex", available: true, version: "1.0.0", binPath: "/usr/bin/codex" }
]

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

/** Render Settings and switch to the MCP section, as the operator would. */
const openMcp = async (props: Partial<React.ComponentProps<typeof SettingsView>> = {}) => {
  render(
    <SettingsView
      clis={CLIS}
      onSaveProvider={vi.fn()}
      loadModels={vi.fn().mockResolvedValue([])}
      ghStatus={{ available: false, authenticated: false, login: null, host: null, version: null }}
      {...props}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: /MCP servers/i }))
}

describe("Settings → MCP servers", () => {
  it("lists the servers the selected harness will load", async () => {
    await openMcp({ loadMcpServers: vi.fn().mockResolvedValue([server(), server({ name: "sentry" })]) })
    expect(await screen.findByText("linear")).toBeTruthy()
    expect(screen.getByText("sentry")).toBeTruthy()
  })

  it("shows each server's scope and transport", async () => {
    await openMcp({ loadMcpServers: vi.fn().mockResolvedValue([server({ scope: "user", transport: "http" })]) })
    expect(await screen.findByText("http")).toBeTruthy()
    // The row's mono meta line leads with scope, then the target.
    expect(screen.getByText(/^user · /)).toBeTruthy()
  })

  it("shows a loading state before the config has been read", async () => {
    await openMcp({ loadMcpServers: vi.fn().mockReturnValue(new Promise(() => {})) })
    expect(await screen.findByText(/Reading claude/i)).toBeTruthy()
  })

  /** An empty config is a normal state, not an error — it must not read as a failure. */
  it("explains an empty config rather than showing an error", async () => {
    await openMcp({ loadMcpServers: vi.fn().mockResolvedValue([]) })
    expect(await screen.findByText(/no MCP servers configured/i)).toBeTruthy()
  })

  it("re-reads when the operator switches harness", async () => {
    const loadMcpServers = vi.fn().mockResolvedValue([])
    await openMcp({ loadMcpServers })
    await waitFor(() => expect(loadMcpServers).toHaveBeenCalledWith("claude"))
    // SegmentedControl renders its segments as tabs, not buttons.
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }))
    await waitFor(() => expect(loadMcpServers).toHaveBeenCalledWith("codex"))
  })

  /**
   * Probing spawns the servers' own commands, so it must never happen just because
   * the operator opened a settings pane.
   */
  it("does not probe until asked", async () => {
    const loadMcpStatus = vi.fn().mockResolvedValue([])
    await openMcp({ loadMcpServers: vi.fn().mockResolvedValue([server()]), loadMcpStatus })
    expect(await screen.findByText("linear")).toBeTruthy()
    expect(loadMcpStatus).not.toHaveBeenCalled()
  })

  it("probes on demand and shows the connected tool count", async () => {
    const status: McpServerStatus = {
      name: "linear",
      scope: "user",
      state: "connected",
      toolCount: 6,
      error: null,
      checkedAt: "2026-07-18T00:00:00.000Z"
    }
    await openMcp({
      loadMcpServers: vi.fn().mockResolvedValue([server()]),
      loadMcpStatus: vi.fn().mockResolvedValue([status])
    })
    fireEvent.click(await screen.findByRole("button", { name: /Check status/i }))
    expect(await screen.findByText(/6 tools/)).toBeTruthy()
  })

  it("surfaces a failed probe's reason", async () => {
    const status: McpServerStatus = {
      name: "linear",
      scope: "user",
      state: "failed",
      toolCount: null,
      error: "spawn ENOENT",
      checkedAt: "2026-07-18T00:00:00.000Z"
    }
    await openMcp({
      loadMcpServers: vi.fn().mockResolvedValue([server()]),
      loadMcpStatus: vi.fn().mockResolvedValue([status])
    })
    fireEvent.click(await screen.findByRole("button", { name: /Check status/i }))
    expect(await screen.findByText(/spawn ENOENT/)).toBeTruthy()
  })

  /** The second press is a re-probe, so it must bypass the cache. */
  it("passes refresh on a recheck but not on the first check", async () => {
    const loadMcpStatus = vi.fn().mockResolvedValue([
      {
        name: "linear",
        scope: "user",
        state: "connected",
        toolCount: 1,
        error: null,
        checkedAt: "2026-07-18T00:00:00.000Z"
      }
    ])
    await openMcp({ loadMcpServers: vi.fn().mockResolvedValue([server()]), loadMcpStatus })
    fireEvent.click(await screen.findByRole("button", { name: /Check status/i }))
    await waitFor(() => expect(loadMcpStatus).toHaveBeenCalledWith("claude", false))
    fireEvent.click(await screen.findByRole("button", { name: /Recheck/i }))
    await waitFor(() => expect(loadMcpStatus).toHaveBeenCalledWith("claude", true))
  })

  /** Settings has no worktree, so it must be explicit that project servers live elsewhere. */
  it("says it is showing user scope only", async () => {
    await openMcp({ loadMcpServers: vi.fn().mockResolvedValue([]) })
    // The nav footer also carries the words "user scope", so scope the assertion
    // to the section's own explanatory callout.
    expect(
      await screen.findByText(/a repo's project\s+servers appear in a session/i)
    ).toBeTruthy()
  })

  it("never renders a secret value", async () => {
    await openMcp({
      loadMcpServers: vi.fn().mockResolvedValue([server({ envKeys: ["LINEAR_API_KEY"] })])
    })
    expect(await screen.findByText(/LINEAR_API_KEY/)).toBeTruthy()
    expect(document.body.textContent).not.toContain("sk-live")
  })
})

describe("mcpRowMeta", () => {
  it("leads with scope and includes the target", () => {
    expect(mcpRowMeta(server())).toBe("user · npx -y @linear/mcp")
  })

  it("shows the tool count once connected", () => {
    expect(
      mcpRowMeta(server(), {
        name: "linear",
        scope: "user",
        state: "connected",
        toolCount: 6,
        error: null,
        checkedAt: "x"
      })
    ).toContain("6 tools")
  })

  it("leads with the failure reason, the most useful thing on screen", () => {
    expect(
      mcpRowMeta(server(), {
        name: "linear",
        scope: "user",
        state: "failed",
        toolCount: null,
        error: "timed out after 5000ms",
        checkedAt: "x"
      })
    ).toContain("timed out after 5000ms")
  })

  it("marks an unapproved server as not enabled", () => {
    expect(mcpRowMeta(server({ enabled: false }))).toContain("not enabled")
  })

  it("lists env and header key names but has nowhere to put a value", () => {
    const meta = mcpRowMeta(server({ envKeys: ["A_KEY"], headerKeys: ["Authorization"] }))
    expect(meta).toContain("env: A_KEY")
    expect(meta).toContain("headers: Authorization")
  })
})
