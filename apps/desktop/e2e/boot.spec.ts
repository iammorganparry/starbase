import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Boot behaviour: which screen the built app lands on, driven entirely by what's
 * in the throwaway `~/starbase`. No config → first-run setup. Seeded config +
 * sessions → the app shell with those sessions.
 */

test("first run (no config) shows the setup screen", async ({ launchApp }) => {
  const { window } = await launchApp()
  await expect(window.getByText("Set up your workspace")).toBeVisible()
  await expect(window.getByRole("button", { name: /choose repos folder/i })).toBeVisible()
})

test("a configured workspace boots into the app shell with its sessions", async ({ launchApp }) => {
  const seeded: SeedSession = {
    id: "s_seed_1",
    repo: "widget",
    branch: "starbase/seed-session",
    title: "Seeded session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z"
  }
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: [seeded] })

  // The sidebar (app shell) is present…
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  // …and the persisted session shows up (grouped under its repo).
  await expect(window.getByText("Seeded session")).toBeVisible()
  // The setup screen is NOT shown.
  await expect(window.getByText("Set up your workspace")).toHaveCount(0)
})
