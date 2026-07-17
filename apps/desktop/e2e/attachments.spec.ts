import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * End-to-end coverage for this pass's UI additions, against the built app and the
 * deterministic scripted adapter: attaching an image as context (thumbnail in the
 * composer, then persisted on the sent user turn) and queueing a message while the
 * agent is busy. We assert on what the operator sees, never on internals.
 *
 * NOTE: the "Changes" rail + header toggle this file used to cover was replaced by
 * a top-level Changes tab (see `rail→tab` in #21); that tab is covered by
 * chat.spec.ts — "a worktree session without a PR shows a Changes tab".
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

/** A tiny on-disk PNG the file picker can attach. */
const writeTinyPng = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "starbase-e2e-img-"))
  const path = join(dir, "login.png")
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  )
  writeFileSync(path, png)
  return path
}

test("attaching an image shows a thumbnail and persists it on the sent turn", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await expect(composer).toBeVisible()

  // Attach an image through the hidden file input (the picker the paperclip opens).
  await window.locator('input[type="file"]').setInputFiles(writeTinyPng())

  // The pending attachment renders as a thumbnail in the composer (by filename).
  await expect(window.getByRole("img", { name: "login.png" })).toBeVisible()

  // Send with a line of text → the user turn carries the image thumbnail + text.
  await composer.click()
  await composer.pressSequentially("Here is the failing screen.")
  await composer.press("Enter")

  await expect(window.getByText("Here is the failing screen.")).toBeVisible()
  // The image persists on the sent turn (still visible after the composer clears).
  await expect(window.getByRole("img", { name: "login.png" })).toBeVisible()
})

test("a message sent while the agent is busy is queued, then processed", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  // `[[plan]]` proposes a plan and parks the run awaiting approval — the agent is
  // busy (not paused for a gate), so the composer stays live with no timing race.
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")

  // The plan card lands and the run is parked → the button becomes "Stop" (the
  // agent is working, so the primary action is to halt it) and the composer
  // placeholder switches to its busy form, which we type into.
  await expect(window.getByRole("button", { name: /Approve plan & start/ }).first()).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByRole("button", { name: /^Stop$/ })).toBeVisible()
  const busyComposer = window.getByPlaceholder("Queue a message while the agent works…")
  await expect(busyComposer).toBeVisible()

  // Queueing lives on ↵ while the button is Stop — the placeholder advertises it.
  await busyComposer.fill("and then open a PR")
  await busyComposer.press("Enter")
  await expect(window.getByText("Queued", { exact: true })).toBeVisible()
  await expect(window.getByText("and then open a PR")).toBeVisible()

  // Approving the plan lets the run finish → the queued turn is dispatched (chip clears).
  await window.getByRole("button", { name: /Approve plan & start/ }).first().click()
  await expect(window.getByText("Queued", { exact: true })).toHaveCount(0, { timeout: 25_000 })
})
