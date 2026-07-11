import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

  // The sidebar reflects the live agent state (was "idle", now working).
  await expect(window.getByText("thinking…")).toBeVisible({ timeout: 10_000 })

  // The assistant turn is labelled with the provider (Claude) in the eyebrow.
  await expect(window.getByText("Claude", { exact: true })).toBeVisible({ timeout: 20_000 })

  // Cost/token readouts were removed (a usage widget replaces them later).
  await expect(window.getByText(/\$0\.00/)).toHaveCount(0)

  // The streamed tool cards render (interleaved with thinking + text).
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })

  // accept-edits mode: the edit auto-applied, but the shell command pauses for HITL.
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("button", { name: /Allow once/ })).toBeVisible()

  // Paused for approval → the live status shows in the sidebar ("needs input")
  // and the tab-bar pill ("Needs input").
  await expect(window.getByText("needs input", { exact: true })).toBeVisible()
  await expect(window.getByText("Needs input", { exact: true })).toBeVisible()

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

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()
  // Switch to Auto via the composer's mode chip (seeded as accept-edits).
  await window.getByText("accept edits").click()
  await window.getByRole("menuitem", { name: "auto" }).click()

  await composer.pressSequentially("Add rate limiting.")
  await composer.press("Enter")

  // The command runs to completion with no gate ever shown.
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 25_000 })
  await expect(window.getByText("Approval needed · run a command")).toHaveCount(0)
})

test("the / menu surfaces built-in + project skills and the @ menu references files", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    // Seed a project skill BEFORE launch so it exists when the app scans skills.
    seed: ({ repoPath }) => {
      const skillDir = join(repoPath, ".claude", "skills", "deploy")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\n")
    }
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()

  // `/` surfaces built-in commands…
  await composer.pressSequentially("/")
  await expect(window.getByText("/plan")).toBeVisible()
  // …and the project skill scanned from the worktree.
  await composer.pressSequentially("deploy")
  await expect(window.getByRole("option", { name: /deploy/ })).toBeVisible()
  await composer.press("Escape")
  for (let i = 0; i < "/deploy".length; i++) await composer.press("Backspace")

  // `@` opens the code-reference palette listing tracked files.
  await composer.pressSequentially("@")
  await expect(window.getByText("README.md").first()).toBeVisible()
})

test("the mode chip lives in the composer and Shift+Tab cycles it", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()

  // Seeded mode is accept-edits → the chip reads "accept edits".
  await expect(window.getByText("accept edits")).toBeVisible()

  // Shift+Tab cycles accept-edits → auto → ask.
  await window.keyboard.press("Shift+Tab")
  await expect(window.getByText("auto")).toBeVisible()
  await window.keyboard.press("Shift+Tab")
  await expect(window.getByText("ask")).toBeVisible()
})

test("the model chip shows the harness model and switches", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await expect(window.getByPlaceholder("Message Claude…")).toBeVisible()

  // Default Claude model is opus (fallback list; no API key in e2e).
  const modelChip = window.getByRole("button", { name: /opus/ })
  await expect(modelChip).toBeVisible()
  await modelChip.click()

  // The menu lists the harness's models — pick sonnet.
  await window.getByRole("menuitem", { name: "sonnet" }).click()
  await expect(window.getByRole("button", { name: /sonnet/ })).toBeVisible()
})
