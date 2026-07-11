import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The full chat experience, end to end against the built app and the
 * deterministic scripted adapter: a prompt streams thinking + tool cards + an
 * inline edit, pauses at a HITL command gate, and resumes on approval; Auto mode
 * skips the gate; and the `/` (skills) and `@` (code) palettes work. We assert on
 * what the operator sees, never on internals.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "starbase/refactor",
    title: "Refactor auth flow",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("streams a turn, pauses at a HITL gate, and resumes on approval", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  const composer = window.getByPlaceholder("Message Claude…")
  await expect(composer).toBeVisible()

  await composer.click()
  await composer.pressSequentially("Add rate limiting to the refund endpoint.")
  await composer.press("Enter")

  // The streamed tool cards render (interleaved with thinking + text).
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })

  // accept-edits mode: the edit auto-applied, but the shell command pauses for HITL.
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("button", { name: /Allow once/ })).toBeVisible()

  await window.getByRole("button", { name: /Allow once/ }).click()

  // Resumed: the gate resolves and the approved command runs to completion.
  await expect(window.getByText("Allowed")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 20_000 })
})

test("Auto mode runs the command without pausing for approval", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("tab", { name: "Auto" }).click()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()
  await composer.pressSequentially("Add rate limiting.")
  await composer.press("Enter")

  // The command runs to completion with no gate ever shown.
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 25_000 })
  await expect(window.getByText("Approval needed · run a command")).toHaveCount(0)
})

test("the / menu surfaces skills and the @ menu references worktree files", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()

  // `/` opens the skills/command palette.
  await composer.pressSequentially("/")
  await expect(window.getByText("/plan")).toBeVisible()
  await composer.press("Escape")

  // `@` opens the code-reference palette listing tracked files.
  await composer.pressSequentially(" @")
  await expect(window.getByText("README.md").first()).toBeVisible()
})
