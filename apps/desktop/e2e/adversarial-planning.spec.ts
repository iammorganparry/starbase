import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Gigaplan — the orchestrated mode — against the REAL built app.
 *
 * These cover what unit tests structurally cannot. `Plan.readiness` is fetched
 * on the conversation machine's entry, so if that RPC were missing from
 * `HandlersLayer` — or its contract disagreed with its handler, both of which
 * type-check fine — the call would reject and readiness would stay null. That is
 * load-bearing twice over: readiness decides whether Gigaplan is offered in the
 * mode chip at all, and whether a send in that mode becomes a round.
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
  launchApp: Parameters<Parameters<typeof test>[1]>[0]["launchApp"]
) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)]
  })
  await expect(launched.window.getByText("Planning session")).toBeVisible()
  await launched.window.getByText("Planning session").click()
  return launched
}

test("Gigaplan is offered in the mode chip, beside the ordinary modes", async ({ launchApp }) => {
  // The e2e host reaches two vendors (fake claude + fake codex), so the mode is
  // offerable. Its presence here is also proof that `Plan.readiness` resolved:
  // the option is omitted entirely when it can't run.
  const { window } = await openSession(launchApp)

  await window.getByRole("button", { name: "accept edits" }).click()
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

  await window.getByRole("button", { name: "accept edits" }).click()
  await window.getByRole("menuitem", { name: "Gigaplan" }).click()

  await expect(window.getByRole("button", { name: "Gigaplan" })).toBeVisible()
  await expect(modelChip).toHaveCount(0)

  // Back to an ordinary mode → the picker returns, on the same model.
  await window.getByRole("button", { name: "Gigaplan" }).click()
  await window.getByRole("menuitem", { name: "ask" }).click()
  await expect(window.getByRole("button", { name: /opus/ })).toBeVisible()
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
  await window.getByRole("button", { name: /Approve/ }).first().click()

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
  await window.getByRole("button", { name: /^Gigaplan/ }).click()

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
})
