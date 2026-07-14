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

test("the mode chip lives in the composer and Shift+Tab cycles it (incl. Plan on Claude)", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.click()

  // The composer wrapper reflects the active mode (drives the per-mode theming).
  const surface = window.locator("[data-mode]").first()

  // Seeded mode is accept-edits → the chip reads "accept edits".
  await expect(window.getByText("accept edits")).toBeVisible()
  await expect(surface).toHaveAttribute("data-mode", "accept-edits")

  // On a Claude session Shift+Tab cycles accept-edits → auto → plan → ask.
  await window.keyboard.press("Shift+Tab")
  await expect(window.getByText("auto")).toBeVisible()
  await expect(surface).toHaveAttribute("data-mode", "auto")

  await window.keyboard.press("Shift+Tab")
  // Plan mode is now reachable (Claude-only) and themes the composer purple.
  await expect(window.getByText("plan")).toBeVisible()
  await expect(surface).toHaveAttribute("data-mode", "plan")

  await window.keyboard.press("Shift+Tab")
  await expect(window.getByText("ask")).toBeVisible()
  await expect(surface).toHaveAttribute("data-mode", "ask")
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

test("the sidebar Usage & limits button opens the usage modal", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The sidebar footer surfaces the usage entry point.
  await window.getByRole("button", { name: /Usage & limits/ }).click()

  // The modal opens with its title and "last updated" footer (provider rows
  // depend on which harnesses are installed on the runner, so we don't assert them).
  const dialog = window.getByRole("dialog")
  await expect(dialog.getByText("Usage & limits")).toBeVisible()
  await expect(dialog.getByText(/Last updated:/)).toBeVisible()
})

// A session linked to a PR — drives the sidebar badge + the PR/Code Review tabs.
const seededPrSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_pr",
    repo: "widget",
    branch: "starbase/refactor",
    title: "Refactor auth flow",
    status: "idle",
    cli: "claude",
    diff: { added: 313, removed: 23 },
    prNumber: 482,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("AskUserQuestion replaces the composer with a question card and resumes on answer", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The `[[ask]]` marker drives the scripted AskUserQuestion flow.
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")

  // The question card takes over the composer slot.
  await expect(window.getByText("Claude needs your input")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Which token strategy should the store use?")).toBeVisible()

  // Q1 (single): pick an option and advance.
  await window.getByText("Rotating refresh tokens").click()
  await window.getByRole("button", { name: /Next/ }).click()

  // Q2 (multi): pick one and submit.
  await expect(window.getByText("Which surfaces should adopt the new store?")).toBeVisible()
  await window.getByText("HTTP middleware").click()
  await window.getByRole("button", { name: /Submit/ }).click()

  // The agent resumes with the answers, and the composer returns.
  await expect(window.getByText(/Got it — starting with/)).toBeVisible({ timeout: 15_000 })
  await expect(window.getByPlaceholder("Message Claude…")).toBeVisible()

  // The answered question persists inline as a "Your answer" record with the picks.
  await expect(window.getByText("Your answer", { exact: true })).toBeVisible()
  await expect(window.getByText("Rotating refresh tokens").last()).toBeVisible()
  await expect(window.getByText("HTTP middleware").last()).toBeVisible()
})

test("a storm of consecutive tool calls collapses to the latest with a +N more toggle", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[storm]] scan the codebase")
  await composer.press("Enter")

  // Four consecutive Reads collapse: only the latest card + a "+3 more" toggle show.
  await expect(window.getByRole("button", { name: /\+ 3 more tool calls/ })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("src/file-1.ts")).toHaveCount(0)
  await expect(window.getByText("src/file-4.ts")).toBeVisible()

  // Expanding reveals the earlier calls; collapsing hides them again.
  await window.getByRole("button", { name: /\+ 3 more tool calls/ }).click()
  await expect(window.getByText("src/file-1.ts")).toBeVisible()
  await window.getByRole("button", { name: /Hide 3 earlier calls/ }).click()
  await expect(window.getByText("src/file-1.ts")).toHaveCount(0)
})

test("Plan mode: propose a plan, review a step, and approve to start execution", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The `[[plan]]` marker drives the scripted plan-mode flow: the agent proposes
  // a structured plan and parks awaiting approval.
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")

  // The inline plan card lands in the transcript with the plan's steps + actions.
  await expect(window.getByRole("button", { name: /Approve plan & start/ }).first()).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByText("Audit session middleware").first()).toBeVisible()

  // The Plan Review tab surfaces (live plan-presence); open it.
  await window.getByText("Plan Review").first().click()

  // The step list renders; drill into a branch step to open its spec.
  await expect(window.getByText("Handle token refresh").first()).toBeVisible()
  await window.getByText("Handle token refresh").first().click()
  await expect(window.getByText("Decide the refresh path on expiry.")).toBeVisible()

  // This step carries its OWN decision flow (flows are now per-step) — the
  // "Control flow" section renders its graph, incl. the "token expired?" decision.
  await expect(window.getByText("Control flow")).toBeVisible()
  await expect(window.getByText("token expired?").first()).toBeVisible()

  // A step without a flow (e.g. "Create TokenStore module") shows no such section.
  await window.getByText("Create TokenStore module").first().click()
  await expect(window.getByText("Decide the refresh path on expiry.")).toHaveCount(0)
  await expect(window.getByText("Control flow")).toHaveCount(0)

  // Approve the plan from the header → the plan flips read-only and execution starts.
  await window.getByRole("button", { name: /Approve plan & start/ }).click()
  await expect(window.getByText(/execution started/i)).toBeVisible({ timeout: 15_000 })

  // Drilling into a step shows its proposed code sample AND a per-step Changes
  // rail (the actual worktree diff for that step's files) on the right.
  await window.getByText("Create TokenStore module").first().click()
  await expect(window.getByText("Proposed code")).toBeVisible()
  await expect(window.getByText("Changes in this step")).toBeVisible()
})

test("a worktree session without a PR shows a Changes tab with the Code Review view", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    seed: ({ repoPath }) => {
      writeFileSync(join(repoPath, "README.md"), "# e2e repo\nan uncommitted edit\n")
    }
  })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // No PR yet → the local worktree diff gets its own top-level Changes tab, which
  // is the Code Review view scoped to the uncommitted (local) source.
  const changesTab = window.getByText("Changes", { exact: true }).first()
  await expect(changesTab).toBeVisible()
  await changesTab.click()
  await expect(window.getByText("Changed files")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("an uncommitted edit")).toBeVisible({ timeout: 20_000 })
})

test("a linked PR shows the sidebar badge and the Pull Request / Code Review tabs", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions
  })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The sidebar row badges the linked PR number.
  await expect(window.getByText(/#482/).first()).toBeVisible()

  // The PR + Code Review tabs appear once a session has a linked PR.
  await expect(window.getByText("Pull Request").first()).toBeVisible()
  const reviewTab = window.getByText("Code Review").first()
  await expect(reviewTab).toBeVisible()

  // The Code Review tab is reachable (its view mounts in place of the stub).
  await reviewTab.click()
  await expect(window.getByText("Next milestone")).toHaveCount(0)
})

test("Code Review shows the Uncommitted source and reverts a whole file", async ({ launchApp }) => {
  // A session whose worktree (the e2e repo) has an uncommitted change. gh isn't
  // authenticated on the runner, so the PR source is empty and the view falls
  // back to the "Uncommitted" (local) diff — where Revert is enabled.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    seed: ({ repoPath }) => {
      writeFileSync(join(repoPath, "README.md"), "# e2e repo\nan uncommitted edit\n")
    }
  })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  await window.getByText("Code Review").first().click()

  // The pane mounts (gh calls for the empty PR source can be slow), the source
  // toggle shows "Uncommitted" selected (the view falls back to the local source),
  // and the local diff renders the changed file + edit.
  await expect(window.getByText("Changed files")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("tab", { name: "Uncommitted" })).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("an uncommitted edit")).toBeVisible({ timeout: 20_000 })

  // Revert the whole file → the uncommitted change disappears from the diff.
  await window.getByRole("button", { name: /Revert file/ }).click()
  await expect(window.getByText("an uncommitted edit")).toHaveCount(0, { timeout: 20_000 })
})

test("the sidebar Settings cog opens the settings view with the GitHub section", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  await window.getByRole("button", { name: "Settings" }).click()

  // The inline Settings view opens (nav + sections), defaulting to Providers —
  // the "Close settings" control and the Providers blurb prove it mounted.
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await expect(
    window.getByText("Set the defaults each agent CLI starts a new session with.")
  ).toBeVisible()

  // Switch to the GitHub section → its section + pull-request toggle render (the
  // exact gh connection line depends on the runner, so we don't assert it).
  await window.getByRole("button", { name: /GitHub/ }).click()
  await expect(window.getByText("Enable pull-request features")).toBeVisible()
})

test("an orphaned pending gate settles on load (its dead buttons disappear)", async ({
  launchApp
}) => {
  // A transcript persisted with a still-pending gate — as if the app was closed
  // (or relaunched) while an approval was waiting. The live run that held the
  // gate's Deferred is gone, so its approve/deny buttons would be dead no-ops.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    transcripts: {
      s_seeded: [
        {
          id: "a_gate",
          role: "assistant",
          streaming: false,
          createdAt: "2026-07-11T00:00:00.000Z",
          parts: [
            { _tag: "Text", text: "I'll run a command." },
            {
              _tag: "Gate",
              gate: {
                id: "g_s_seeded_1",
                kind: "command",
                title: "run a command",
                detail: "Not in your allowlist.",
                command: "find . -name orphaned-gate",
                allowLabel: "find",
                status: "pending"
              }
            }
          ]
        }
      ]
    }
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  // The seeded session auto-selects; its transcript (with the gate) loads.
  await expect(window.getByText("find . -name orphaned-gate")).toBeVisible()

  // On load the gate is settled → shown resolved ("Denied"), NOT "waiting", and
  // its approve/deny buttons are gone (they could never resolve a dead run).
  await expect(window.getByText("Denied")).toBeVisible()
  await expect(window.getByText("waiting")).toHaveCount(0)
  await expect(window.getByRole("button", { name: /Allow once/ })).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Deny" })).toHaveCount(0)
})

test("a stale plan (reopened app) can be approved to re-drive execution", async ({ launchApp }) => {
  // A transcript persisted with a still-proposed plan — as after quitting the app
  // mid-plan. The live run that held the approval is gone, so on load the plan
  // settles to "stale" and must be re-approved via a fresh run.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    transcripts: {
      s_seeded: [
        {
          id: "a_plan",
          role: "assistant",
          streaming: false,
          createdAt: "2026-07-11T00:00:00.000Z",
          parts: [
            { _tag: "Text", text: "Here's my plan." },
            {
              _tag: "Plan",
              plan: {
                id: "plan_s_seeded_1",
                summary: "Refactor the auth flow",
                graph: null,
                steps: [
                  {
                    id: "s_01",
                    number: "01",
                    title: "Add a TokenStore",
                    intent: "Centralise token handling",
                    approach: [],
                    kind: "step",
                    condition: null,
                    parentId: null,
                    dependsOn: [],
                    blocks: [],
                    files: [],
                    guards: [],
                    code: null,
                    diff: null,
                    status: "proposed",
                    flagged: false
                  }
                ],
                comments: [],
                status: "proposed",
                raw: "# Refactor the auth flow"
              }
            }
          ]
        }
      ]
    }
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  // The seeded session auto-selects; a plan present → the Plan Review tab shows.
  await window.getByText("Plan Review").first().click()
  await expect(window.getByText("Refactor the auth flow").first()).toBeVisible()

  // On load the orphaned plan is "stale" → not the normal Approve, but a distinct
  // re-drive affordance.
  await expect(window.getByText(/reopened — approve to resume/i)).toBeVisible()
  await window.getByRole("button", { name: /Approve & implement/ }).click()

  // Approving re-drives a fresh run: the plan flips out of stale (Execution
  // started) and the resume turn lands in the conversation.
  await expect(window.getByText(/Execution started/i)).toBeVisible({ timeout: 15_000 })
  await window.getByText("Conversation").first().click()
  await expect(window.getByText("Approved — implement the plan.")).toBeVisible({ timeout: 15_000 })
})

test("an archived session shows in the Archived group, read-only, and restores", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      {
        id: "s_arch",
        repo: "widget",
        branch: "feat/oauth",
        title: "Refactor auth flow",
        status: "idle",
        cli: "claude",
        diff: { added: 0, removed: 0 },
        prNumber: 482,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-07-11T00:00:00.000Z",
        worktreePath: repoPath,
        baseBranch: "main",
        archived: true,
        archiveReason: "merged",
        archivedAt: "2026-07-10T00:00:00.000Z"
      }
    ]
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The session sits in the "Archived" sidebar group with a Merged pill.
  await expect(window.getByText("Archived", { exact: true })).toBeVisible()
  await expect(window.getByText("Merged #482")).toBeVisible()

  // It auto-selects → the archived banner + locked composer render (read-only).
  await expect(window.getByText(/was merged/)).toBeVisible()
  await expect(window.getByText(/Composer disabled/)).toBeVisible()

  // Restore it → archived state clears (banner + lock gone, real composer back).
  await window.getByRole("button", { name: "Restore session" }).click()
  await expect(window.getByText(/Composer disabled/)).toHaveCount(0)
  await expect(window.getByText("Merged #482")).toHaveCount(0)
})

// Two plain sessions so the sidebar quick-actions have something to act on and
// the list stays non-empty after one is removed.
const twoSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_keep",
    repo: "widget",
    branch: "starbase/one",
    title: "First session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  },
  {
    id: "s_act",
    repo: "widget",
    branch: "starbase/two",
    title: "Second session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    mode: "accept-edits"
  }
]

test("sidebar quick-actions: hover a row to archive an active session", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: twoSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // No Archived group yet — both sessions are active.
  await expect(window.getByText("Archived", { exact: true })).toHaveCount(0)

  // Hover the second row to reveal its quick-actions, then Archive it.
  const row = window.getByTestId("session-row-s_act")
  await row.hover()
  await window.getByRole("button", { name: "Archive Second session" }).click()

  // It drops into the Archived group (undoable via Restore).
  await expect(window.getByText("Archived", { exact: true })).toBeVisible()
})

test("sidebar quick-actions: right-click → Delete removes a session after confirming", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: twoSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await expect(window.getByText("Second session")).toBeVisible()

  // Right-click the row opens the context menu; choose Delete.
  const row = window.getByTestId("session-row-s_act")
  await row.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Delete" }).click()

  // Delete is destructive → a confirm dialog gates it. Cancel first leaves it.
  const dialog = window.getByRole("dialog")
  await expect(dialog.getByText("Delete session?")).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(window.getByTestId("session-row-s_act")).toBeVisible()

  // Reopen and confirm → the row is permanently gone (the other session remains).
  await row.click({ button: "right" })
  await window.getByRole("menuitem", { name: "Delete" }).click()
  await window.getByRole("dialog").getByRole("button", { name: "Delete" }).click()

  await expect(window.getByTestId("session-row-s_act")).toHaveCount(0)
  await expect(window.getByText("Second session")).toHaveCount(0)
  await expect(window.getByText("First session")).toBeVisible()
})

test("a merged PR auto-archives its linked session on load", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    // gh reports this PR as merged; the sweep should archive the session.
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 500,
          title: "Old shipped work",
          headRefName: "chore/shipped",
          baseRefName: "main",
          author: { login: "e2e-user" },
          state: "MERGED"
        }
      ]
    },
    sessions: ({ repoPath }) => [
      {
        id: "s_open",
        repo: "widget",
        branch: "chore/shipped",
        title: "Old shipped work",
        status: "idle",
        cli: "claude",
        diff: { added: 0, removed: 0 },
        prNumber: 500,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-07-11T00:00:00.000Z",
        worktreePath: repoPath,
        baseBranch: "main"
        // NOT archived — the sweep must archive it because PR #500 is merged.
      }
    ]
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The archive sweep detects the merged PR → the session moves into Archived.
  await expect(window.getByText("Archived", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Merged #500")).toBeVisible()
})
