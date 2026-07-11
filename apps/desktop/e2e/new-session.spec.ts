import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"

/**
 * The full ⌘N create-session flow, end to end against real git: open the dialog,
 * name the session, pick a base branch, hit Create, and verify the real outcomes
 * — the session shows in the sidebar, a real worktree + `starbase/<slug>` branch
 * were created, and the session was persisted to sessions.json.
 */
test("creating a session forks a real worktree and persists it", async ({ launchApp }) => {
  const { window, home, repoPath } = await launchApp({ configured: true, withRepo: true })

  // Wait for the configured shell, then open the New Session dialog.
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.locator('button[title="New session"]').click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()

  // Creating a session needs an installed coding CLI (real host discovery). Skip
  // cleanly on a host with none — this is a local, non-CI flow.
  const noHarness = await window.getByText("No harness available").count()
  test.skip(noHarness > 0, "no coding CLI installed on this host")

  await window.getByPlaceholder("Refactor auth refresh").fill("Fix login")

  // Repo, harness and base branch all default from discovery — Create should
  // enable without any manual selection. (Regression guard: the base-branch
  // default used to be cleared by a spurious Radix Select change.)
  const create = window.getByRole("button", { name: "Create" })
  await expect(create).toBeEnabled()
  await create.click()

  // The new session appears in the sidebar (dialog closed).
  await expect(window.getByText("Fix login")).toBeVisible()

  // Real outcome: the worktree exists on disk under the throwaway ~/starbase.
  const worktreePath = join(home, "starbase", "worktrees", "widget", "fix-login")
  expect(existsSync(worktreePath)).toBe(true)

  // Real outcome: the branch was created in the origin repo.
  const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
    cwd: repoPath,
    encoding: "utf-8"
  })
  expect(branches).toContain("starbase/fix-login")

  // Real outcome: the session was persisted to sessions.json.
  const persisted = JSON.parse(readFileSync(join(home, "starbase", "sessions.json"), "utf-8"))
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Fix login",
    branch: "starbase/fix-login",
    repo: "widget",
    status: "idle"
  })
})
