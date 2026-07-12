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

/**
 * The "new session from an existing PR" flow, end to end against real git with a
 * deterministic fake `gh`: toggle the dialog to "From PR", pick an open PR, hit
 * Create, and verify the session was created ON the PR's head branch and linked
 * to its number (so the sidebar badge + PR tabs light up).
 */
test("creating a session from a PR checks out its head branch and links the PR", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Fix auth refresh race",
          headRefName: "chore/bump",
          baseRefName: "main",
          author: { login: "octocat" },
          additions: 31,
          deletions: 4
        },
        {
          number: 471,
          title: "Add usage window",
          headRefName: "feat/usage",
          baseRefName: "main",
          author: { login: "hubot" }
        }
      ]
    }
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.locator('button[title="New session"]').click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()

  // From-PR creation still needs an installed harness to drive the session.
  const noHarness = await window.getByText("No harness available").count()
  test.skip(noHarness > 0, "no coding CLI installed on this host")

  // The fake gh reports authenticated, so the "From PR" toggle is available.
  await window.getByRole("tab", { name: "From PR" }).click()

  // The picker chrome + the seeded open PRs render.
  await expect(window.getByPlaceholder("Search open pull requests…")).toBeVisible()
  await expect(window.getByText("Just mine")).toBeVisible()
  await expect(window.getByText("Fix auth refresh race")).toBeVisible()
  await expect(window.getByText("#482")).toBeVisible()

  // Select PR #482 → Create enables → create the session.
  await window.getByText("Fix auth refresh race").click()
  const create = window.getByRole("button", { name: "Create" })
  await expect(create).toBeEnabled()
  await create.click()

  // Wait for creation to complete: the dialog closes and the new session's PR
  // badge (`⑂ #482`, only in the sidebar) appears. Only then is the worktree on disk.
  await expect(window.getByRole("heading", { name: "New session" })).toBeHidden()
  await expect(window.getByText("⑂ #482")).toBeVisible()

  // Real outcome: the worktree is on the PR's head branch (not a starbase/ fork).
  const worktreePath = join(home, "starbase", "worktrees", "widget", "fix-auth-refresh-race")
  expect(existsSync(worktreePath)).toBe(true)
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf-8"
  }).trim()
  expect(branch).toBe("chore/bump")

  // Real outcome: the session is persisted with the PR linked.
  const persisted = JSON.parse(readFileSync(join(home, "starbase", "sessions.json"), "utf-8"))
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Fix auth refresh race",
    branch: "chore/bump",
    baseBranch: "main",
    prNumber: 482,
    repo: "widget"
  })
})
