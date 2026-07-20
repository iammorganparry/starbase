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

  // The sidebar reflects the LIVE agent state (was Idle, now working). The row
  // reports one of five words — Thinking, then Running as tools start — and each
  // lasts a few hundred ms, so racing one specific word is flaky. Having LEFT
  // "Idle" is the stable fact; the settled live label is asserted at the gate
  // below.
  //
  // The casing is load-bearing: `exact` means "Idle" and "idle" are different
  // strings, so a stale lowercase matcher here would pass vacuously — count 0
  // whether or not the session ever left idle — and quietly stop testing.
  const row = window.getByTestId("session-row-s_seeded")
  await expect(row.getByText("Idle", { exact: true })).toHaveCount(0, { timeout: 10_000 })

  // The assistant turn is labelled with the provider (Claude) in the eyebrow.
  await expect(window.getByText("Claude", { exact: true })).toBeVisible({ timeout: 20_000 })

  // Cost/token readouts were removed (a usage widget replaces them later).
  await expect(window.getByText(/\$0\.00/)).toHaveCount(0)

  // The streamed tool cards render (interleaved with thinking + text).
  await expect(window.getByText("src/routes/billing.ts").first()).toBeVisible({ timeout: 20_000 })

  // accept-edits mode: the edit auto-applied, but the shell command pauses for HITL.
  await expect(window.getByText("Approval needed · run a command")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("button", { name: /Allow once/ })).toBeVisible()

  // Paused for approval → the live status reaches BOTH surfaces: the sidebar row
  // and the tab-bar pill. They deliberately speak different vocabularies, and the
  // casing is the tell:
  //
  //   - the row reports a fixed sidebar state, Title Case  → "Needs Input"
  //   - the pill renders the activity's own label, prose    → "Needs input"
  //     (the same register as "Searching the web" / "Wrapping up")
  //
  // So each is scoped to its surface and matched exactly — an unscoped matcher
  // would prove neither.
  await expect(row.getByText("Needs Input", { exact: true })).toBeVisible()
  await expect(
    window.getByTestId("session-tab-bar").getByText("Needs input", { exact: true })
  ).toBeVisible()

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

  // The menu lists EVERY installed harness's models grouped by provider, so
  // `sonnet` must be matched exactly — Cursor also offers a `sonnet-4.5`, and a
  // substring match resolves to both.
  await window.getByRole("menuitem", { name: "sonnet", exact: true }).click()
  await expect(window.getByRole("button", { name: /sonnet/ })).toBeVisible()
})

/**
 * Switching provider from the model chip.
 *
 * The menu only lists installed harnesses, so this used to skip unless the
 * developer personally had the Codex CLI — meaning it asserted nothing on CI and
 * something different on every machine. Discovery is now pinned to the fixture's
 * bin dir, which ships a fake `codex` speaking the app-server protocol, so the
 * harness is always present and the skip has been removed: if Codex is missing
 * from the menu now, that is a real failure.
 */
test("the model chip switches provider", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByPlaceholder("Message Claude…")).toBeVisible()

  await window.getByRole("button", { name: /opus/ }).click()
  await expect(window.getByText("Codex CLI", { exact: true })).toBeVisible()

  // The catalogue comes from the CLI itself, so assert the shape of an id
  // (`GPT-5.…`) rather than a specific one — it moves upstream.
  const codexModel = window.getByRole("menuitem").filter({ hasText: /^GPT-5\./ }).first()
  const label = (await codexModel.textContent())!.trim()
  await codexModel.click()

  // The chip follows the pick, and the composer now addresses the new harness.
  await expect(window.getByRole("button", { name: label })).toBeVisible()
  await expect(window.getByPlaceholder("Message Codex…")).toBeVisible()
})

test("the sidebar Usage & limits button opens the usage modal", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The sidebar footer account menu surfaces the usage entry point.
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /Usage & limits/ }).click()

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

test("Plan mode: propose a plan, review a step, and approve in auto", async ({
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
  await expect(window.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByRole("button", { name: "Approve and auto", exact: true }).first()).toBeVisible()
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

  // Approve in auto from the header → the plan flips read-only, the execution
  // override becomes visible in the mode chip, and execution starts.
  await window.getByRole("button", { name: "Approve and auto", exact: true }).click()
  await expect(window.getByText(/execution started/i)).toBeVisible({ timeout: 15_000 })
  await window.getByText("Conversation", { exact: true }).first().click()
  await expect(window.getByRole("button", { name: "auto", exact: true })).toBeVisible()
  await window.getByText("Plan Review", { exact: true }).first().click()

  // Drilling into a step shows its proposed code sample AND a per-step Changes
  // rail (the actual worktree diff for that step's files) on the right.
  await window.getByText("Create TokenStore module").first().click()
  await expect(window.getByText("Proposed code")).toBeVisible()
  await expect(window.getByText("Changes in this step")).toBeVisible()
})

test("the plan can be split beside the conversation instead of replacing it", async ({
  launchApp
}) => {
  // This replaced a narrow step-progress rail, which could only ever be a lossy
  // restatement of Plan Review in a column too small to act on. The split shows
  // the REAL thing — and, crucially, without unmounting the conversation, since
  // that would abort a live run.
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  await expect(window.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible({
    timeout: 15_000
  })

  // The composer's placeholder tracks the run state (it reads "Queue a message…"
  // while the agent is parked awaiting approval), so match either wording — the
  // point here is that the composer EXISTS, not what it currently says.
  const anyComposer = window.getByPlaceholder(/message claude|queue a message/i)

  // Split on: the transcript's composer is STILL mounted (no tab swap) and the
  // selected step is on screen at the same time. At this width the review must
  // not retain its own fixed list and changes rails: those were what squeezed
  // the centre pane into the malformed layout.
  const split = window.getByRole("button", { name: /split plan beside conversation/i })
  await split.click()
  await expect(anyComposer).toBeVisible()
  await expect(window.getByText("Decide the refresh path on expiry.", { exact: true })).toBeVisible()
  await expect(window.getByRole("separator", { name: /resize plan/i })).toBeVisible()
  await expect(window.getByRole("separator", { name: /resize step list/i })).toHaveCount(0)
  await expect(window.getByRole("separator", { name: /resize changes/i })).toHaveCount(0)

  // Split off: the plan column goes, the conversation stays put.
  await split.click()
  await expect(anyComposer).toBeVisible()
  await expect(window.getByRole("separator", { name: /resize plan/i })).toHaveCount(0)
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

test("the Pull Request tab leads with the description, in the conversation's column", async ({
  launchApp
}) => {
  // `pr.body` was fetched and carried in the schema from the start but never
  // drawn, so this tab opened straight onto the review timeline — the case FOR
  // the change missing from the page reviewing it.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Refactor auth flow",
          headRefName: "starbase/refactor",
          baseRefName: "main",
          author: { login: "e2e-user" },
          additions: 313,
          deletions: 23,
          body: "## Why\n\nSession tokens were compared with `===`, which short-circuits.",
          labels: [{ name: "security" }]
        }
      ]
    }
  })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByText("Pull Request").first().click()

  // The description renders as the opening comment — markdown and all.
  await expect(window.getByRole("heading", { name: "Why" })).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText(/short-circuits/)).toBeVisible()
  await expect(window.getByText("opened this")).toBeVisible()
  await expect(window.getByText("security")).toBeVisible()

  // Continuity with the Conversation view: the same 760px reading column. Asserted
  // as a real measured width so a stray class change can't silently widen it.
  const column = window.locator(".max-w-\\[760px\\]").first()
  await expect(column).toBeVisible()
  const box = await column.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(760)
})

test("the merge box offers a strategy, and merges with the one chosen", async ({ launchApp }) => {
  // `PrMergeMethod` and `gh pr merge --<method>` supported all three from the
  // start; only the UI didn't, so every merge from here was a merge commit —
  // squash being most teams' default made this the likeliest reason to give up
  // and open the browser.
  const { window, ghCalls } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Refactor auth flow",
          headRefName: "starbase/refactor",
          baseRefName: "main",
          author: { login: "e2e-user" }
        }
      ]
    }
  })
  await window.getByText("Pull Request").first().click()

  // Default is a merge commit — the picker must not silently change what the
  // button already did.
  const mergeButton = window.getByRole("button", { name: "Merge pull request" })
  await expect(mergeButton).toBeVisible({ timeout: 20_000 })

  // Choosing squash re-labels the action, so the button says what will happen.
  await window.getByRole("radio", { name: "Squash" }).click()
  await expect(window.getByRole("button", { name: "Squash and merge" })).toBeVisible()

  await window.getByRole("button", { name: "Squash and merge" }).click()
  await expect.poll(() => ghCalls().join("\n"), { timeout: 15_000 }).toContain("--squash")
})

test("an out-of-date branch offers Update branch, not just a blocker", async ({ launchApp }) => {
  // `mergeStateStatus` was fetched all along and only ever collapsed into a
  // blocker STRING, so the box stated the problem and offered nothing. Being
  // behind is the one blocker the operator can clear from here.
  const { window, ghCalls } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Refactor auth flow",
          headRefName: "starbase/refactor",
          baseRefName: "main",
          author: { login: "e2e-user" },
          mergeStateStatus: "BEHIND"
        }
      ]
    }
  })
  await window.getByText("Pull Request").first().click()

  await expect(window.getByText("Branch is out of date with the base")).toBeVisible({
    timeout: 20_000
  })
  await window.getByRole("button", { name: "Update branch" }).click()
  await expect.poll(() => ghCalls().join("\n"), { timeout: 15_000 }).toContain("update-branch")
})

test("a passing check still links to its run", async ({ launchApp }) => {
  // The details link used to be failures-only, so a green check was a dead end —
  // no way to see why it took nine minutes or what it actually covered.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Refactor auth flow",
          headRefName: "starbase/refactor",
          baseRefName: "main",
          author: { login: "e2e-user" },
          checks: [{ name: "build", detailsUrl: "https://ci.example/build/1" }]
        }
      ]
    }
  })
  await window.getByText("Pull Request").first().click()

  const details = window.getByRole("link", { name: "Details for build" })
  await expect(details).toBeVisible({ timeout: 20_000 })
  await expect(details).toHaveAttribute("href", "https://ci.example/build/1")
  // The duration is still reported beside it — they were alternatives before.
  await expect(window.getByText("48s")).toBeVisible()
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

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()

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

test("a merged PR badges its linked session but never archives it", async ({ launchApp }) => {
  // This used to assert the opposite — the sweep auto-archived a session as soon
  // as its linked PR merged. That was wrong: a session record holds ONE
  // `prNumber` but routinely outlives several PRs (open one, merge it, keep
  // working off the same worktree, open the next), so merging the first PR made
  // a live session vanish from the sidebar mid-flight. Merge state now only
  // badges the row; retiring a session is the operator's call.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    // gh reports this PR as merged; the sweep should badge, not archive.
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
        // NOT archived — and it must STAY that way despite PR #500 being merged.
      }
    ]
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // Waiting on the badge is what proves the PR-state poll actually ran — without
  // it, "was not archived" would pass trivially by asserting before the sweep.
  await expect(window.getByText(/#500 Merged/)).toBeVisible({ timeout: 15_000 })
  // Still an active session: no Archived group was created for it.
  await expect(window.getByText("Old shipped work")).toBeVisible()
  await expect(window.getByRole("button", { name: /collapse archived/i })).toHaveCount(0)
})

/**
 * The adversarial reviewer is a full agent run. Before this it ran completely
 * unobserved — a bare "Reviewing…" spinner for minutes, with its output dropped
 * on the floor. It must now report where it is on the button, and be watchable in
 * the agent tab bar like any other agent.
 */
test("a running adversarial review reports its phase and appears in the agent tab bar", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Refactor auth flow",
          headRefName: "starbase/refactor",
          baseRefName: "main",
          author: { login: "octocat" },
          state: "OPEN"
        }
      ]
    }
  })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The browser preview docks over the right rail, covering the review button.
  // Collapse it only IF it's open: its visibility persists in localStorage across
  // runs, so an unconditional toggle opens it whenever the last run left it shut.
  // `exact` also matters — otherwise this matches "Hide browser preview" too.
  const preview = window.getByRole("button", { name: "Browser preview", exact: true })
  if ((await preview.getAttribute("aria-pressed")) === "true") await preview.click()

  await window.getByText("Pull Request").first().click()
  const runButton = window.getByRole("button", { name: /Adversarial review/ })
  await expect(runButton).toBeEnabled()
  await runButton.click()

  // The button names what the reviewer is actually doing. "Starting…" is
  // deliberately NOT accepted: it's the default phase and renders off the pending
  // mutation alone, so it would pass with the event stream completely broken.
  // Only a LATER phase proves the reviewer's events reached the button.
  await expect(
    window.getByRole("button", { name: /Reading the code…|Thinking…|Writing findings…/ })
  ).toBeVisible({ timeout: 20_000 })

  // …and the reviewer is watchable in the agent tab bar, mid-run.
  await window.getByText("Conversation").first().click()
  await expect(window.getByRole("button", { name: /Reviewer/ })).toBeVisible()
})

/**
 * A finished review's findings already survive a restart, so its Reviewer tab has
 * to as well — a tab that vanishes while its verdict is still on screen reads as
 * a bug. A fresh launch with a stored reviewer transcript and no live review is
 * exactly that case: the tab can only come from the disk.
 */
test("a finished reviewer's tab is restored after a restart", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededPrSessions,
    reviewTranscripts: {
      s_pr: [
        { _tag: "Started", sessionId: "review_s_pr" },
        { _tag: "ToolStart", id: "t1", name: "Read", target: "src/auth.ts" },
        { _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null },
        { _tag: "Assistant", text: "A stale token can be reused after logout." },
        { _tag: "Done", costUsd: 0, tokens: 0 }
      ]
    }
  })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

  // The tab is back with the previous run's output readable behind it.
  const reviewerTab = window.getByRole("button", { name: /Reviewer/ })
  await expect(reviewerTab).toBeVisible()
  await reviewerTab.click()
  await expect(window.getByText(/stale token can be reused/)).toBeVisible()

  // Restored as finished, not mid-flight: the stored stream ends in `Done`, which
  // is why only completed runs are ever persisted — a half-written one would come
  // back as a reviewer that appears to still be working with nothing behind it.
  await expect(window.getByText("watch-only")).toBeVisible()
})
