import { fileURLToPath } from "node:url"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * MCP config + status, end to end against the built app.
 *
 * Hermetic by construction: `STARBASE_HARNESS_HOME` (seeded by the `mcp` launch
 * option) points the app at a throwaway `~`, and every server points at the same
 * deterministic fake MCP server the unit tests use. So this says the same thing on
 * a machine with no harness installed as on the developer's own — no `test.skip`
 * on a real binary, unlike the model-chip specs.
 *
 * We assert on what the operator sees, never on internals.
 */

/** The stdio MCP server fixture, driven by an argv mode (`ok` / `crash` / `hang`). */
const FAKE_SERVER = fileURLToPath(
  new URL("../../../packages/cli-adapters/src/mcp-fixtures/fake-mcp-server.mjs", import.meta.url)
)

/** A value planted in config that must never reach the DOM. */
const SECRET = "sk-live-E2E-MUST-NOT-LEAK"

const stdioServer = (mode: ReadonlyArray<string>, env?: Record<string, string>) => ({
  command: process.execPath,
  args: [FAKE_SERVER, ...mode],
  ...(env ? { env } : {})
})

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_mcp",
    repo: "widget",
    branch: "starbase/mcp",
    title: "MCP session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-18T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

/** Open Settings and land on the MCP servers section. */
const openMcpSettings = async (window: import("@playwright/test").Page) => {
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: /MCP servers/ }).click()
}

// ── Settings ─────────────────────────────────────────────────────────────────

test("Settings lists the harness's configured MCP servers", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { userServers: { linear: stdioServer(["ok", "3"]), posthog: { url: "https://mcp.posthog.com/mcp" } } }
  })
  await openMcpSettings(window)

  await expect(window.getByText("linear", { exact: true })).toBeVisible()
  await expect(window.getByText("posthog", { exact: true })).toBeVisible()
  // Transport is shown per row: one spawns a command, one is remote.
  await expect(window.getByText("stdio", { exact: true }).first()).toBeVisible()
  await expect(window.getByText("http", { exact: true }).first()).toBeVisible()
})

test("Settings explains an empty MCP config rather than looking broken", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions, mcp: {} })
  await openMcpSettings(window)
  await expect(window.getByText(/no MCP servers configured/i)).toBeVisible()
})

test("Settings probes on demand and reports the live tool count", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { userServers: { linear: stdioServer(["ok", "3"]) } }
  })
  await openMcpSettings(window)

  await window.getByRole("button", { name: /Check status/i }).click()
  // The real handshake ran against the fake server and counted its tools.
  await expect(window.getByText(/3 tools/)).toBeVisible({ timeout: 15_000 })
})

test("a broken MCP server reports as failed instead of hanging the UI", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { userServers: { broken: stdioServer(["crash"]), healthy: stdioServer(["ok", "1"]) } }
  })
  await openMcpSettings(window)

  await window.getByRole("button", { name: /Check status/i }).click()
  // The healthy sibling still reports — one bad server doesn't sink the batch,
  // and the pane stays interactive.
  await expect(window.getByText(/1 tools/)).toBeVisible({ timeout: 15_000 })
  await expect(window.getByRole("button", { name: /Recheck/i })).toBeEnabled()
})

test("Settings never renders a configured secret value", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { userServers: { creds: stdioServer(["ok", "1"], { LINEAR_API_KEY: SECRET }) } }
  })
  await openMcpSettings(window)

  // The key's NAME is shown, so the operator can see what it expects…
  await expect(window.getByText(/LINEAR_API_KEY/)).toBeVisible()
  // …but its value never crosses into the renderer.
  expect(await window.content()).not.toContain(SECRET)
})

// ── Composer ─────────────────────────────────────────────────────────────────

test("the composer chip opens a dialog showing user and project servers", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: {
      userServers: { userSrv: stdioServer(["ok", "2"]) },
      projectServers: { projSrv: stdioServer(["ok", "1"]) },
      // Approve project servers where Claude actually records approvals — the repo's
      // .claude/settings.local.json, NOT the user-level settings.json.
      projectSettings: { enableAllProjectMcpServers: true }
    }
  })

  await window.getByText("MCP session").click()
  const chip = window.getByTitle("MCP server status")
  await expect(chip).toBeVisible()
  await expect(chip).toContainText("2 MCP")

  await chip.click()
  // Only this surface has a worktree, so it's the only one that can show project scope.
  await expect(window.getByText("User", { exact: true })).toBeVisible()
  await expect(window.getByText("Project", { exact: true })).toBeVisible()
  await expect(window.getByText("userSrv", { exact: true })).toBeVisible()
  await expect(window.getByText("projSrv", { exact: true })).toBeVisible()
})

test("the composer chip stays hidden when nothing is configured", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: {}
  })
  await window.getByText("MCP session").click()
  // Wait for the composer itself, so this isn't just asserting on an unrendered pane.
  await expect(window.getByRole("button", { name: /Send/ })).toBeVisible()
  await expect(window.getByTitle("MCP server status")).toBeHidden()
})

test("the dialog's refresh re-probes and reports status", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { userServers: { linear: stdioServer(["ok", "4"]) } }
  })

  await window.getByText("MCP session").click()
  await window.getByTitle("MCP server status").click()

  // Opening probes once.
  await expect(window.getByText(/4 tools/)).toBeVisible({ timeout: 15_000 })

  await window.getByRole("button", { name: "Refresh" }).click()
  await expect(window.getByText(/4 tools/)).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText(/checked/i)).toBeVisible()
})

test("the dialog warns when a server didn't respond", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { userServers: { broken: stdioServer(["crash"]) } }
  })

  await window.getByText("MCP session").click()
  await window.getByTitle("MCP server status").click()
  await expect(window.getByText(/1 server didn't respond/i)).toBeVisible({ timeout: 15_000 })
})

/**
 * The approval gate, end to end, at the two places Claude actually records it.
 * The original implementation read only `~/.claude/settings.json` — which in a real
 * install carries none of these keys — so an operator who had approved their project
 * servers through the normal prompt saw every one of them as "not enabled".
 */
test("a project server approved in the repo's settings.local.json is live, not 'not enabled'", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: {
      projectServers: { approved: stdioServer(["ok", "5"]) },
      projectSettings: { enabledMcpjsonServers: ["approved"] }
    }
  })

  await window.getByText("MCP session").click()
  await window.getByTitle("MCP server status").click()
  await expect(window.getByText("approved", { exact: true })).toBeVisible()
  // It was probed rather than skipped as disabled — proof the gate resolved.
  await expect(window.getByText(/5 tools/)).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText(/not enabled/)).toBeHidden()
})

test("a project server approved via ~/.claude.json projects[<repo>] is live", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: {
      projectServers: { approved: stdioServer(["ok", "2"]) },
      projectEntry: { enabledMcpjsonServers: ["approved"] }
    }
  })

  await window.getByText("MCP session").click()
  await window.getByTitle("MCP server status").click()
  await expect(window.getByText(/2 tools/)).toBeVisible({ timeout: 15_000 })
})

test("an unapproved project server still shows, marked not enabled", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: { projectServers: { pending: stdioServer(["ok", "1"]) } }
  })

  await window.getByText("MCP session").click()
  await window.getByTitle("MCP server status").click()
  // Visible (so the operator can see WHY it's inert) but never probed.
  await expect(window.getByText("pending", { exact: true })).toBeVisible()
  await expect(window.getByText(/not enabled/)).toBeVisible()
})

test("a user-scope server disabled for this project shows as not enabled", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    mcp: {
      userServers: { obsidian: stdioServer(["ok", "1"]), linear: stdioServer(["ok", "1"]) },
      // `disabledMcpServers` turns a server off whatever scope defined it.
      projectEntry: { disabledMcpServers: ["obsidian"] }
    }
  })

  await window.getByText("MCP session").click()
  await window.getByTitle("MCP server status").click()
  await expect(window.getByText("obsidian", { exact: true })).toBeVisible()
  await expect(window.getByText(/not enabled/)).toBeVisible()
})
