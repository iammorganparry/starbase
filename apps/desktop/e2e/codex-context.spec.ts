import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Codex context telemetry and native compaction, through the built Electron app
 * and a real child-process app-server transport. Unlike the scripted chat E2E,
 * this crosses stdio JSON-RPC, the adapter, AgentRunner, IPC, renderer state and
 * the context meter.
 */
const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_codex_context",
    repo: "widget",
    branch: "starbase/codex-context",
    title: "Long Codex session",
    status: "idle",
    cli: "codex",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    contextTokens: 206_000,
    updatedAt: "2026-07-23T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto",
    model: "gpt-5.6-sol",
    resumeId: "thread-e2e"
  }
]

test("shows live Codex context and compacts an overloaded resume before the turn", async ({
  launchApp
}) => {
  const { window, codexCalls } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    scriptedAgent: false
  })

  const composer = window.getByPlaceholder("Message Codex…")
  await expect(composer).toBeVisible()
  await composer.fill("Continue the implementation.")
  await composer.press("Enter")

  await expect
    .poll(() => codexCalls(), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(["thread/resume", "thread/compact/start", "turn/start"]))

  // The app-server publishes 120k while the turn is still open. Seeing both the
  // meter and Stop proves the reading was not deferred until Done.
  await expect(window.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 20_000 })
  const meter = window.getByRole("button", { name: "Compact now" })
  await expect(meter).toContainText("120k", { timeout: 20_000 })

  await expect(window.getByText("Codex E2E complete.")).toBeVisible({ timeout: 20_000 })

  const calls = codexCalls()
  expect(calls.indexOf("thread/resume")).toBeLessThan(calls.indexOf("thread/compact/start"))
  expect(calls.indexOf("thread/compact/start")).toBeLessThan(calls.indexOf("turn/start"))
})
