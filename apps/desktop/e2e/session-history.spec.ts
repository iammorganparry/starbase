import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Session history across restarts, and the sidebar's account of a session's
 * lifecycle. Three regressions live here, all found in one sitting:
 *
 *  1. A truncating transcript write meant a dev restart could zero a session's
 *     transcript — the conversation pane came back BLANK, with no error, because
 *     every read path treats an unreadable transcript as "no history yet".
 *  2. A merged PR auto-archived its whole session, but a session holds ONE
 *     `prNumber` while routinely outliving several PRs, so a live multi-PR
 *     session vanished from the sidebar the moment its first PR merged.
 *  3. The Archived group inherited `sessions.json` order (`updatedAt`), so a
 *     just-archived session sorted below ones archived days earlier — buried
 *     exactly when you go looking for it.
 */

const baseSession = (over: Partial<SeedSession> & { id: string }): SeedSession => ({
  repo: "widget",
  branch: `starbase/${over.id}`,
  title: over.id,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-16T00:00:00.000Z",
  ...over
})

/** A two-turn conversation in the shape `TranscriptStore` persists. */
const conversation = [
  {
    id: "u_s_hist_1",
    role: "user",
    parts: [{ _tag: "Text", text: "what does the auth module do" }],
    streaming: false,
    createdAt: "2026-07-16T00:00:00.000Z"
  },
  {
    id: "a_s_hist_2",
    role: "assistant",
    parts: [{ _tag: "Text", text: "It issues and verifies bearer tokens." }],
    streaming: false,
    createdAt: "2026-07-16T00:00:01.000Z"
  }
]

const longConversation = Array.from({ length: 40 }, (_, index) => ({
  id: `${index % 2 === 0 ? "u" : "a"}_s_long_${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  parts: [
    {
      _tag: "Text",
      text: [
        `Turn ${index + 1}`,
        "This persisted turn is deliberately tall enough to exercise transcript virtualization.",
        "Opening an existing chat should land on its newest message, not the beginning of its history."
      ].join("\n\n")
    }
  ],
  streaming: false,
  createdAt: `2026-07-16T00:${String(index).padStart(2, "0")}:00.000Z`
}))

test("opening a long existing chat starts at the bottom", async ({ launchApp }) => {
  const session = baseSession({ id: "s_long", title: "Long history" })
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [session],
    transcripts: { s_long: longConversation }
  })

  await window.getByText("Long history").click()
  await expect(window.getByText("Turn 40", { exact: true })).toBeAttached()

  const transcript = window.getByTestId("conversation-scroll")
  // Rich transcript content (images, highlighted code, expanded tool output)
  // can finish sizing after the initial virtualizer pass. Simulate that late
  // growth on the newest rendered turn: sticky-bottom must absorb it.
  await transcript.locator("[data-index='39']").evaluate((turn) => {
    const lateContent = document.createElement("div")
    lateContent.style.height = "480px"
    lateContent.dataset.testid = "late-transcript-content"
    turn.append(lateContent)
  })

  await expect
    .poll(
      () =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight
        ),
      { timeout: 5_000 }
    )
    .toBeLessThan(5)
})

test("a session's history survives a real app restart", async ({ launchApp }) => {
  const session = baseSession({ id: "s_hist", title: "History session" })
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [session],
    transcripts: { s_hist: conversation }
  })

  await first.window.getByText("History session").click()
  await expect(first.window.getByText("It issues and verifies bearer tokens.")).toBeVisible()
  await first.app.close()

  // Relaunch against the SAME ~/starbase — nothing is re-seeded, so the history
  // can only come from what the first run left on disk.
  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await second.window.getByText("History session").click()
  await expect(second.window.getByText("what does the auth module do")).toBeVisible()
  await expect(second.window.getByText("It issues and verifies bearer tokens.")).toBeVisible()
})

test("a transcript zeroed by a killed write opens empty rather than breaking the session", async ({
  launchApp
}) => {
  // Simulates the state the old truncating write left behind. Two things must
  // hold: the app still opens the session (a decode failure must not take the
  // pane down), and the session itself is still listed and usable.
  const session = baseSession({ id: "s_zero", title: "Zeroed session" })
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [session],
    transcripts: { s_zero: conversation }
  })
  await first.app.close()

  writeFileSync(join(first.home, "starbase", "transcripts", "s_zero.json"), "")

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await expect(second.window.getByText("Zeroed session")).toBeVisible()
  await second.window.getByText("Zeroed session").click()
  // The composer is the proof the pane mounted rather than erroring out.
  await expect(second.window.getByPlaceholder(/message claude/i)).toBeVisible()
})

test("history written during a run is still there after a restart", async ({ launchApp }) => {
  // The end-to-end version of the atomic-write fix: drive a real (scripted) run,
  // then restart and assert the turn persisted. This is what actually broke —
  // the transcript is rewritten on nearly every stream event, so the window for a
  // truncating write to be interrupted was enormous.
  const session = baseSession({ id: "s_run", title: "Run session" })
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (ctx) => [{ ...session, worktreePath: ctx.repoPath }],
    transcripts: { s_run: [] }
  })

  await first.window.getByText("Run session").click()
  await first.window.getByPlaceholder(/message claude/i).fill("summarise the repo")
  await first.window.getByRole("button", { name: /send/i }).click()
  await expect(first.window.getByText("summarise the repo")).toBeVisible()

  // Let the scripted harness finish and the transcript settle on disk.
  const transcriptPath = join(first.home, "starbase", "transcripts", "s_run.json")
  await expect
    .poll(() => JSON.parse(readFileSync(transcriptPath, "utf8")).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })
  await second.window.getByText("Run session").click()
  await expect(second.window.getByText("summarise the repo")).toBeVisible()
})

test("a session whose PR merged stays in the sidebar instead of auto-archiving", async ({
  launchApp
}) => {
  // Regression 2. The `gh` fake reports PR #7 as merged; the session must remain
  // listed and active, because merging one PR says nothing about whether the
  // session's work is finished.
  const session = baseSession({ id: "s_merged", title: "Multi PR session", prNumber: 7 })
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (ctx) => [{ ...session, worktreePath: ctx.repoPath }],
    gh: {
      login: "morgan",
      prs: [
        {
          number: 7,
          title: "Multi PR session",
          headRefName: "starbase/s_merged",
          baseRefName: "main",
          author: { login: "morgan" },
          state: "MERGED"
        }
      ]
    }
  })

  await expect(window.getByText("Multi PR session")).toBeVisible()

  // Wait for the MERGED badge first. This is load-bearing: it proves the PR-state
  // poll actually completed. Asserting "not archived" without it passes trivially
  // — the assertion runs before the sweep has fetched anything, so the test would
  // stay green even if auto-archiving were reinstated.
  await expect(window.getByText(/#7 Merged/)).toBeVisible({ timeout: 20_000 })

  // Now the interesting part: merged, and STILL an active session.
  await expect(window.getByText("Multi PR session")).toBeVisible()
  await expect(window.getByRole("button", { name: /collapse archived/i })).toHaveCount(0)
  const persisted = JSON.parse(readFileSync(join(home, "starbase", "sessions.json"), "utf8"))
  expect(persisted[0]?.archived ?? false).toBe(false)
})

test("the Archived group lists the most recently archived session first", async ({ launchApp }) => {
  // Regression 3. `sessions.json` order is by `updatedAt`, so the session with
  // the OLDEST last turn is deliberately the one archived most recently.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [
      baseSession({
        id: "s_recent_turn",
        title: "Recently updated",
        updatedAt: "2026-07-18T07:00:00.000Z",
        archived: true,
        archiveReason: "merged",
        archivedAt: "2026-07-18T08:00:00.000Z"
      }),
      baseSession({
        id: "s_just_archived",
        title: "Just archived",
        updatedAt: "2026-07-16T15:42:00.000Z",
        archived: true,
        archiveReason: "merged",
        archivedAt: "2026-07-18T14:25:00.000Z"
      })
    ]
  })

  await expect(window.getByRole("button", { name: /collapse archived/i })).toBeVisible()
  const rows = window.locator("[data-testid^='session-row-']")
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("Just archived")
  await expect(rows.last()).toContainText("Recently updated")
})
