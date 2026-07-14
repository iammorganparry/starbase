import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The native PTY terminal, end to end against the built app. Unlike the agent,
 * the terminal has NO scripted mode — it spawns a REAL login shell in the
 * session's worktree — so we drive it with deterministic input and assert on the
 * dock's React chrome (tabs, the "last exit" footer), NOT on the xterm buffer:
 * xterm renders its text to a WebGL canvas that isn't in the DOM.
 *
 * What this proves end to end: the dock mounts and auto-spawns a terminal, the
 * `+` button creates another, keystrokes reach the PTY over IPC, and the PTY's
 * exit propagates back through the `Terminal.attach` stream into the UI.
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
    // The terminal's cwd is the session's worktree — a real git repo here.
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("auto-spawns a terminal in the dock and the `+` button adds another", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The dock is visible by default and auto-spawns one terminal for the active
  // session — so an xterm surface appears with no user action.
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: 20_000 })

  // A second terminal from the dock's "New terminal" (+) affordance.
  await window.getByRole("button", { name: "New terminal" }).click()
  await expect(window.locator(".xterm")).toHaveCount(2, { timeout: 20_000 })
})

test("keystrokes reach the PTY and its exit surfaces in the dock footer", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const term = window.locator(".xterm").first()
  await expect(term).toBeVisible({ timeout: 20_000 })

  // Focus the terminal and exit the shell. `exit` cleanly ends the login shell →
  // the PTY closes with code 0 → the Terminal.attach stream emits an `exit` frame
  // → the dock footer renders "last exit 0" (real React DOM, renderer-agnostic).
  await term.click()
  await window.keyboard.type("exit")
  await window.keyboard.press("Enter")

  // "last exit 0" — the label + the exit code render in one footer span.
  await expect(window.getByText("last exit 0")).toBeVisible({ timeout: 20_000 })
})
