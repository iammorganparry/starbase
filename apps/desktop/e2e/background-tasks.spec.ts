import { expect, test } from "./fixtures.js"
import type { LaunchedApp, LaunchOptions, SeedSession } from "./fixtures.js"

/**
 * Background tasks end to end: work the agent starts that OUTLIVES the turn.
 *
 * The regression this whole feature answers: an agent could background a shell
 * command or a sub-agent and it would run to completion with nothing in the UI
 * to say it existed — no way to see it, no way to stop it. The scripted harness
 * starts one on `[[background]]` and then ENDS the turn while it runs on, which
 * is precisely the situation that used to be invisible.
 */

const session = (over: Partial<SeedSession> & { id: string }): SeedSession => ({
  repo: "widget",
  branch: `starbase/${over.id}`,
  title: over.id,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
  ...over
})

type LaunchApp = (options?: LaunchOptions) => Promise<LaunchedApp>

const launch = (launchApp: LaunchApp, cli: SeedSession["cli"] = "claude") =>
  launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [session({ id: "s_bg", title: "Background session", cli, worktreePath: repoPath })]
  })

/** Send the marker prompt that makes the scripted harness background a task. */
const startBackgroundTask = async (window: LaunchedApp["window"]) => {
  await window.getByPlaceholder(/message claude/i).fill("watch the tests [[background]]")
  await window.getByRole("button", { name: /send/i }).click()
}

test("a background task appears in the dock and survives the turn ending", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await window.getByText("Background session").click()
  await startBackgroundTask(window)

  // The turn finishes — the agent's reply lands — and the task is STILL listed.
  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByTestId("background-task-dock")).toBeVisible()
  const row = window.locator("[data-testid^='bg-task-']").first()
  await expect(row).toContainText("Watching the test suite")
  await expect(row).toHaveAttribute("data-status", "running")
  await expect(window.getByText("1 running")).toBeVisible()
})

test("the dock reports a running task's live progress", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await window.getByText("Background session").click()
  await startBackgroundTask(window)

  const row = window.locator("[data-testid^='bg-task-']").first()
  // While a task runs there is no output stream — these counters ARE the view.
  await expect(row).toContainText("12s")
  await expect(row).toContainText("3 tools")
  await expect(row).toContainText("1.2k tokens")
})

test("stopping a task settles it, and the row says so", async ({ launchApp }) => {
  const { window } = await launch(launchApp)
  await window.getByText("Background session").click()
  await startBackgroundTask(window)

  const row = window.locator("[data-testid^='bg-task-']").first()
  await expect(row).toHaveAttribute("data-status", "running")
  await window.getByRole("button", { name: /stop watching the test suite/i }).click()

  // The scripted harness confirms the stop the way a real one does — through the
  // same settle + level signals — so the row ends in `stopped`, not `stopping`.
  await expect(row).toHaveAttribute("data-status", "stopped")
  await expect(row).toContainText("Stopped by the operator")
  // No Stop button on a settled task.
  await expect(window.getByRole("button", { name: /stop watching/i })).toHaveCount(0)
})

test("the dock is hidden for a harness with no background-task support", async ({ launchApp }) => {
  // Codex can only abort a whole turn, so a dock with a Stop button would be a
  // lie about what the operator can actually do.
  const { window } = await launch(launchApp, "codex")
  await window.getByText("Background session").click()
  await window.getByPlaceholder(/message codex/i).fill("watch the tests [[background]]")
  await window.getByRole("button", { name: /send/i }).click()

  await expect(window.getByText("Started a watcher in the background.")).toBeVisible()
  await expect(window.getByTestId("background-task-dock")).toHaveCount(0)
})

test("there is no dock until something actually runs in the background", async ({ launchApp }) => {
  // An empty dock is chrome that costs attention and reports nothing.
  const { window } = await launch(launchApp)
  await window.getByText("Background session").click()
  await expect(window.getByPlaceholder(/message claude/i)).toBeVisible()
  await expect(window.getByTestId("background-task-dock")).toHaveCount(0)
})
