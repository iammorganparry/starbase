import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.js"
import type { LaunchOptions, SeedSession } from "./fixtures.js"

const GIGAPLAN_SETTINGS = /^Gigaplan/

/**
 * Gigaplan — the orchestrated mode — against the REAL built app.
 *
 * These cover what unit tests structurally cannot. `Plan.readiness` is fetched
 * on the conversation machine's entry, so if that RPC were missing from
 * `HandlersLayer` — or its contract disagreed with its handler, both of which
 * type-check fine — the call would reject and readiness would stay null. That is
 * Readiness decides whether Gigaplan and its explicit plan handoff are offered.
 *
 * Driven through the UI rather than an injected RPC global on purpose: adding a
 * test hook to production code to verify production code is a weaker check than
 * exercising the path a user actually takes.
 *
 * The suite runs with `STARBASE_SCRIPTED_AGENT=1`, so no real harness is ever
 * spawned and no model is ever called.
 */

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_plan_1",
  repo: "widget",
  branch: "starbase/plan-session",
  title: "Planning session",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
  worktreePath
})

const openSession = async (
  launchApp: Parameters<Parameters<typeof test>[1]>[0]["launchApp"],
  options: LaunchOptions = {}
) => {
  const launched = await launchApp({
    ...options,
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)]
  })
  await expect(launched.window.getByText("Planning session")).toBeVisible()
  await launched.window.getByText("Planning session").click()
  return launched
}

const runGigaplanRound = async (window: Page) => {
  await window.getByRole("button", { name: "accept edits" }).click()
  await window.getByRole("menuitem", { name: "Gigaplan" }).click()
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("Add deterministic request limits")
  await composer.press("Enter")
  // The first message is intake on the configured orchestrator. A round starts
  // only when the operator explicitly hands that conversation to the planners.
  const createPlan = window.getByRole("button", { name: "Create plan" })
  await expect(createPlan).toBeEnabled({ timeout: 30_000 })
  await createPlan.click()
  await expect(window.getByText("Plan Review").first()).toBeVisible({ timeout: 30_000 })
  await window.getByText("Plan Review").first().click()
  await expect(window.getByRole("button", { name: /^01 Add request limiter/ })).toBeVisible({
    timeout: 30_000
  })
  await window.getByRole("button", { name: /^01 Add request limiter/ }).click()
}

test("Gigaplan is offered in the mode chip, beside the ordinary modes", async ({ launchApp }) => {
  // The e2e host reaches two vendors (fake claude + fake codex), so the mode is
  // offerable. Its presence here is also proof that `Plan.readiness` resolved:
  // the option is omitted entirely when it can't run.
  const { window } = await openSession(launchApp)

  await window.getByRole("button", { name: "accept edits" }).click()
  await expect(window.getByRole("menuitem", { name: "plan", exact: true })).toBeVisible()
  await expect(window.getByRole("menuitem", { name: "Gigaplan" })).toBeVisible()
})

test("selecting Gigaplan takes the model picker away, and changing mode brings it back", async ({
  launchApp
}) => {
  // The point of the mode is that it assigns a model per step from the plan it
  // had reviewed. A model chip left on screen would be a control that is
  // silently overridden — worse than no control at all. It must come straight
  // back, though: the operator's own choice was never discarded.
  const { window } = await openSession(launchApp)

  const modelChip = window.getByRole("button", { name: /opus/ })
  await expect(modelChip).toBeVisible()

  const ordinaryMode = window.getByRole("button", { name: "accept edits" })
  await ordinaryMode.click()
  await window.getByRole("menuitem", { name: "Gigaplan" }).click()

  const gigaplanMode = window.getByRole("button", { name: "Gigaplan" })
  await expect(gigaplanMode).toBeVisible()
  await expect(modelChip).toHaveCount(0)

  // Back to an ordinary mode → the picker returns, on the same model.
  await window.getByRole("button", { name: "Gigaplan" }).click()
  await window.getByRole("menuitem", { name: "ask" }).click()
  await expect(window.getByRole("button", { name: /opus/ })).toBeVisible()
})

test("Gigaplan follow-ups stay conversational until Create plan is clicked", async ({
  launchApp
}) => {
  const { window } = await openSession(launchApp)
  await window.getByRole("button", { name: "accept edits" }).click()
  await window.getByRole("menuitem", { name: "Gigaplan" }).click()
  const composer = window.getByPlaceholder("Message Claude…")
  const createPlan = window.getByRole("button", { name: "Create plan" })

  await composer.fill("Preserve the active filters")
  await composer.press("Enter")
  await expect(createPlan).toBeEnabled({ timeout: 30_000 })

  await composer.fill("Also include hidden columns")
  await composer.press("Enter")
  await expect(createPlan).toBeEnabled({ timeout: 30_000 })

  await expect(window.getByRole("button", { name: /^01 Add request limiter/ })).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Update plan" })).toHaveCount(0)
})

test("a real shadow round preserves execution while showing the semantic recommendation", async ({
  launchApp
}) => {
  test.setTimeout(90_000)
  const { window } = await openSession(launchApp)
  await runGigaplanRound(window)

  await expect(window.getByLabel("Will run on claude opus").last()).toBeVisible()
  await expect(window.getByText(/Shadow recommendation: codex\/gpt-5\.5/)).toBeVisible()
  await expect(window.getByText(/system-default · gigaplan-routing-v\d+/)).toBeVisible()
})

test("a real active round applies the deterministic semantic route", async ({ launchApp }) => {
  test.setTimeout(90_000)
  const { window } = await openSession(launchApp, {
    config: { gigaplanRouting: { mode: "active", overrides: [] } }
  })
  await runGigaplanRound(window)

  await expect(window.getByLabel("Will run on codex gpt-5.5").last()).toBeVisible()
  await expect(window.getByText(/policy-profile · gigaplan-routing-v\d+/)).toBeVisible()
  await expect(window.getByText(/Shadow recommendation:/)).toHaveCount(0)
})

test("a disabled provider cannot make Gigaplan look runnable", async ({ launchApp }) => {
  const { window } = await openSession(launchApp, {
    config: {
      providers: { codex: { enabled: false, defaultMode: "accept-edits" } }
    }
  })

  await window.getByRole("button", { name: "accept edits" }).click()
  await expect(window.getByRole("menuitem", { name: "Gigaplan" })).toHaveCount(0)
})

test("Starbase is no longer a harness you can pick a model from", async ({ launchApp }) => {
  // Gigaplan hides this picker while it runs, so an entry here could only ever
  // be selected in order to be ignored. One way to ask, not two.
  const { window } = await openSession(launchApp)

  await window.getByRole("button", { name: /opus/ }).click()
  // Scoped to the open menu: "Starbase" is the app's own name and appears in
  // the window chrome, so a page-wide text assertion would fail for the wrong
  // reason.
  const menu = window.getByRole("menu")
  await expect(menu.getByRole("menuitem", { name: "orchestrate" })).toHaveCount(0)
  await expect(menu.getByText("Starbase", { exact: true })).toHaveCount(0)
})

test("learning is OFF on a real first boot, and leaves no trace", async ({ launchApp }) => {
  // Not "collects quietly and withholds". A fresh install must write nothing at
  // all, and this is asserted against the real state directory rather than a
  // mocked config, because that is exactly the claim the settings pane makes.
  const { window, home } = await openSession(launchApp)
  await expect(window.getByText("Planning session")).toBeVisible()

  const starbase = join(home, "starbase")
  const entries = existsSync(starbase) ? readdirSync(starbase) : []
  expect(entries).not.toContain("outcomes")
  expect(entries).not.toContain("plan-rounds")
})

test("approving a Gigaplan runs its steps, each on the harness the plan assigned", async ({
  launchApp
}) => {
  // Above the suite's 60s default: the scripted adapter streams a full realistic
  // turn per step at a visible cadence, and this runs two of them back to back.
  test.setTimeout(180_000)
  // The payoff for the whole feature, and the one thing unit tests cannot prove:
  // that the contract, the handler, the layer wiring and the renderer agree well
  // enough for an approved plan to actually execute per-step. The two steps are
  // assigned to DIFFERENT harnesses, so seeing both tabs is proof the assignment
  // survived the round trip rather than everything landing on one agent.
  const twoStepPlan = (assigneeA: string, assigneeB: string) => ({
    id: "plan_s_plan_1_1",
    summary: "Add a tier column",
    graph: null,
    comments: [],
    status: "proposed",
    raw: "# Add a tier column",
    steps: [
      {
        id: "s_01",
        number: "01",
        title: "Add the column",
        intent: "Accounts need a tier.",
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
        flagged: false,
        assignee: { cli: assigneeA, model: "gpt-5.6-sol", reason: "schema work" }
      },
      {
        id: "s_02",
        number: "02",
        title: "Backfill it",
        intent: "Existing rows need values.",
        approach: [],
        kind: "step",
        condition: null,
        parentId: null,
        dependsOn: ["01"],
        blocks: [],
        files: [],
        guards: [],
        code: null,
        diff: null,
        status: "proposed",
        flagged: false,
        assignee: { cli: assigneeB, model: "opus", reason: "app code" }
      }
    ]
  })

  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    transcripts: {
      s_plan_1: [
        {
          id: "a_plan",
          role: "assistant",
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          parts: [
            { _tag: "Text", text: "Here is the plan." },
            { _tag: "Plan", plan: twoStepPlan("codex", "claude") }
          ]
        }
      ]
    }
  })

  await expect(window.getByText("Planning session")).toBeVisible()
  await window.getByText("Planning session").click()

  // Gigaplan must be ON, or approval re-drives on one harness instead.
  await window.getByRole("button", { name: "accept edits" }).click()
  await window.getByRole("menuitem", { name: "Gigaplan" }).click()
  await expect(window.getByRole("button", { name: "Gigaplan" })).toBeVisible()

  await window.getByText("Plan Review").first().click()
  await expect(window.getByLabel("Assigned to codex gpt-5.6-sol")).toBeVisible()
  await window.getByRole("button", { name: /^02 Backfill it/ }).click()
  await expect(window.getByText("Assigned model", { exact: true })).toBeVisible()
  await expect(window.getByLabel("Assigned to claude opus").last()).toBeVisible()
  await window.getByRole("button", { name: "Approve & implement", exact: true }).click()

  await expect(window.getByText(/Execution started/i)).toBeVisible({ timeout: 30_000 })

  // The executor turn — text only `beginPlanExecution` writes — proves approval
  // took the Gigaplan path rather than re-driving on the session's own harness.
  await window.getByText("Conversation").first().click()
  await expect(window.getByText("Approved — run the plan.")).toBeVisible({ timeout: 30_000 })

  // The closing tally: only the executor emits this, and only after walking
  // every step. It is the assertion that the run reaches the END, which is
  // exactly what a leaked child `Done` used to prevent — the first step to
  // finish tore the stream down and the run died mid-plan.
  await expect(window.getByText(/Ran 2 of 2 steps/)).toBeVisible({ timeout: 90_000 })
})

test("the Gigaplan settings pane is reachable and states its default", async ({ launchApp }) => {
  // A composite nobody can open is worse than none — `LearningsSettings` sat
  // built-but-unwired for exactly this reason, which is why this asserts the
  // NAVIGATION rather than the component in isolation.
  const { window } = await openSession(launchApp)

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: GIGAPLAN_SETTINGS }).click()

  await expect(window.getByText("Orchestrator model")).toBeVisible()

  // Billing is surfaced, not merely acted on: the failure this reports was
  // SILENT — an exported API key overriding a paid plan with nothing on screen
  // to say so. The fixture seeds an empty harness home, so no subscription is
  // detectable and every harness reads "not signed in". That the panel arrives
  // at all is proof `Billing.paths` round-tripped; that it says "not signed in"
  // is proof the probe read the SEEDED home rather than the developer's real
  // one, which is what makes this test say the same thing on every machine.
  await expect(window.getByText("What this is charged to")).toBeVisible()
  await expect(window.getByText("not signed in").first()).toBeVisible()
  // The default is stated, never left implicit — an operator should not have to
  // read the source to learn what it runs on out of the box.
  await expect(window.getByText(/Using the default \(claude · opus\)/)).toBeVisible()

  // Legacy workspaces have no routing key, so they must enter the observational
  // rollout. An explicit opt-in is persisted through the real RPC/config path.
  const shadow = window.getByRole("tab", { name: "Shadow" })
  const active = window.getByRole("tab", { name: "Active" })
  await expect(shadow).toHaveAttribute("aria-selected", "true")
  await active.click()
  await expect(active).toHaveAttribute("aria-selected", "true")

  await window.getByRole("button", { name: "Close settings" }).click()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: GIGAPLAN_SETTINGS }).click()
  await expect(window.getByRole("tab", { name: "Active" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
})

/**
 * Plan mode on a NON-Claude harness, end to end.
 *
 * The gate that kept plan mode Claude-only lived in four places at once — the
 * composer chip, the Shift+Tab cycle, and the renderer AND main-process
 * coercions that fired on a harness switch. Each is unit-tested, but three of
 * them fail SILENTLY (they drop the mode rather than erroring), so a disagreement
 * between them looks like a bug with no message. Only driving the real app
 * proves the four now agree.
 *
 * What this deliberately does NOT cover: the Codex adapter's own plan loop. The
 * suite runs with `STARBASE_SCRIPTED_AGENT=1`, so the scripted adapter answers
 * here — see `codex-plan-loop.test.ts` for the real fenced-block round trip
 * against a mocked SDK.
 */
const codexSeed = (worktreePath: string): SeedSession => ({
  ...seeded(worktreePath),
  id: "s_plan_codex",
  title: "Codex planning session",
  cli: "codex",
  mode: "accept-edits"
})

test("plan mode is offered on a Codex session and proposes a reviewable plan", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [codexSeed(repoPath)]
  })
  await window.getByText("Codex planning session").click()

  // 1. The chip offers it. Before this change `allowPlan` was false off-Claude,
  //    so the option was omitted from the menu entirely — not disabled, absent.
  await window.getByRole("button", { name: "accept edits" }).click()
  await expect(window.getByRole("menuitem", { name: "plan", exact: true })).toBeVisible()
  await window.getByRole("menuitem", { name: "plan", exact: true }).click()
  await expect(window.locator("[data-mode]").first()).toHaveAttribute("data-mode", "plan")

  // 2. The mode survives to the runner and comes back as a reviewable plan card,
  //    rather than being coerced to `ask` on the way.
  const composer = window.getByPlaceholder(/Message/)
  await composer.fill("refactor auth to a TokenStore")
  await composer.press("Enter")

  await expect(window.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByText("Audit session middleware").first()).toBeVisible()
})

test("switching harness mid-plan keeps plan mode instead of dropping it", async ({ launchApp }) => {
  // Both coercion sites (renderer `persistHarness`, main `setHarness`) used to
  // fire on any move off Claude. A switch between two planning harnesses now
  // costs the operator nothing.
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)]
  })
  await window.getByText("Planning session").click()

  await window.getByRole("button", { name: "accept edits" }).click()
  await window.getByRole("menuitem", { name: "plan", exact: true }).click()
  await expect(window.locator("[data-mode]").first()).toHaveAttribute("data-mode", "plan")

  await window.getByRole("button", { name: /opus/ }).click()
  // The catalogue comes from the CLI itself, so match the shape of an id
  // (`GPT-5.…`) rather than a specific one — it moves upstream.
  await window.getByRole("menuitem").filter({ hasText: /^GPT-5\./ }).first().click()

  await expect(window.getByPlaceholder("Message Codex…")).toBeVisible()
  await expect(window.locator("[data-mode]").first()).toHaveAttribute("data-mode", "plan")
})
