import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The session grid, driven through the real built app.
 *
 * These exist because the grid's bugs have all been INTERACTION bugs that unit
 * tests could not reach: a pane click destroying the native browser preview, the
 * close button blanking the whole app, a sidebar click yanking a session out of
 * the pane it was visibly sitting in. jsdom cannot see any of that.
 *
 * The drags below are dispatched synthetically (see `dragTo`), so they exercise
 * the real handlers against a real `DataTransfer` in real Chromium — the wiring,
 * the payload round-trip, and every state change that follows. What they do NOT
 * reproduce is the spec's protected mode, where a genuine user drag blanks
 * `getData` until drop. That is why `carriesSession` checks `types` rather than
 * reading a value, and no automated test here can catch a regression on that
 * specific point; the unit suite documents it instead.
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

const SESSIONS: ReadonlyArray<SeedSession> = [
  baseSession({ id: "s_alpha", title: "Alpha session" }),
  baseSession({ id: "s_beta", title: "Beta session" }),
  baseSession({ id: "s_gamma", title: "Gamma session" })
]

/**
 * Perform a real HTML5 drag from one element to another.
 *
 * Playwright's `dragTo` (and any hand-driven mouse down/move/up) does NOT start
 * an HTML5 drag in Chromium — the native drag loop is outside the CDP input
 * domain, so `dragstart` never fires and the drop handlers never see a payload.
 * Dispatching the real `DragEvent`s with ONE shared `DataTransfer` is the
 * faithful alternative: our own `dragstart` handler writes the payload into it,
 * and our `dragover`/`drop` handlers read it back exactly as they would live.
 */
const dragTo = (page: Page, sourceTestId: string, targetTestId: string) =>
  page.evaluate(
    ({ source, target }) => {
      const src = document.querySelector(`[data-testid="${source}"]`)
      const tgt = document.querySelector(`[data-testid="${target}"]`)
      if (!src || !tgt) throw new Error(`missing drag node: ${source} → ${target}`)
      const dataTransfer = new DataTransfer()
      const fire = (node: Element, type: string) =>
        node.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }))
      fire(src, "dragstart")
      fire(tgt, "dragenter")
      fire(tgt, "dragover")
      fire(tgt, "drop")
      fire(src, "dragend")
    },
    { source: sourceTestId, target: targetTestId }
  )

/** Which session sits in each slot, read off the rendered grid. */
const slotSessions = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="grid-slot-"]'))
      .filter((el) => /grid-slot-\d+$/.test(el.getAttribute("data-testid") ?? ""))
      .map((el) => el.getAttribute("data-session"))
  )

test("dragging a sidebar session into an empty pane puts it there", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  // Split into two columns — slot 1 is now an empty drop target.
  await window.getByTestId("layout-mode-1|1").click()
  await expect(window.getByTestId("grid-slot-empty-1")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "grid-slot-1")

  // The placeholder is gone and Beta is rendering in the second pane.
  await expect(window.getByTestId("grid-slot-empty-1")).toHaveCount(0)
  expect(await slotSessions(window)).toEqual(["s_alpha", "s_beta"])
})

test("a gridded session badges its pane number in the sidebar", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await window.getByTestId("layout-mode-1|1").click()
  await dragTo(window, "session-row-s_beta", "grid-slot-1")

  // 1-based for display: slot 1 reads as "2".
  await expect(window.getByTestId("session-slot-badge-s_beta")).toHaveText("2")
  await expect(window.getByTestId("session-slot-badge-s_alpha")).toHaveText("1")
  // Gamma is not on the grid, so it carries no badge.
  await expect(window.getByTestId("session-slot-badge-s_gamma")).toHaveCount(0)
})

test("dropping onto an occupied pane swaps the two sessions", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await window.getByTestId("layout-mode-1|1").click()
  await dragTo(window, "session-row-s_beta", "grid-slot-1")
  expect(await slotSessions(window)).toEqual(["s_alpha", "s_beta"])

  // Alpha is already in slot 0. Dropping it onto slot 1 must TRADE places rather
  // than duplicate it — one session drives exactly one conversation actor.
  await dragTo(window, "session-row-s_alpha", "grid-slot-1")
  expect(await slotSessions(window)).toEqual(["s_beta", "s_alpha"])
})

test("dragging a session already on the grid moves it rather than duplicating", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await window.getByTestId("layout-mode-2|2").click()
  await dragTo(window, "session-row-s_beta", "grid-slot-1")
  // Move Beta from slot 1 to the empty slot 3 — slot 1 must empty, not clone.
  await dragTo(window, "session-row-s_beta", "grid-slot-3")

  const slots = await slotSessions(window)
  expect(slots.filter((id) => id === "s_beta")).toHaveLength(1)
  expect(slots[3]).toBe("s_beta")
  expect(slots[1]).toBeNull()
})

test("closing a pane empties its slot and leaves the others alone", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await window.getByTestId("layout-mode-1|1").click()
  await dragTo(window, "session-row-s_beta", "grid-slot-1")

  // Close the pane that currently has focus (the drop focused slot 1). The
  // regression this guards: `showEmpty` keyed off the FOCUSED session, so
  // closing the focused pane replaced the whole app with the first-launch
  // screen — taking the other live pane with it.
  await window.getByTestId("grid-slot-1").getByTestId("close-pane").click()

  await expect(window.getByTestId("grid-slot-empty-1")).toBeVisible()
  expect(await slotSessions(window)).toEqual(["s_alpha", null])
  // The app shell is still here — NOT the "create a session" empty state.
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
})

test("clicking a session already on the grid focuses its pane instead of rearranging", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await window.getByTestId("layout-mode-1|1").click()
  await dragTo(window, "session-row-s_beta", "grid-slot-1")
  expect(await slotSessions(window)).toEqual(["s_alpha", "s_beta"])

  // Focus is on slot 1 after the drop. Clicking Alpha's row — Alpha being
  // visibly in slot 0 — must simply move focus there. Routing it through the
  // assign path would apply swap semantics and rearrange both panes.
  await window.getByTestId("session-row-s_alpha").click()

  expect(await slotSessions(window)).toEqual(["s_alpha", "s_beta"])
  await expect(window.getByTestId("grid-slot-0")).toHaveAttribute("data-focused", "true")
})

test("the layout and its sessions survive a real app restart", async ({ launchApp }) => {
  const first = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(first.window.getByText("Alpha session")).toBeVisible()

  await first.window.getByTestId("layout-mode-2|1").click()
  await dragTo(first.window, "session-row-s_beta", "grid-slot-1")
  await dragTo(first.window, "session-row-s_gamma", "grid-slot-2")
  expect(await slotSessions(first.window)).toEqual(["s_alpha", "s_beta", "s_gamma"])

  await first.app.close()

  // Relaunch against the SAME ~/starbase — localStorage carries sb.layout.v1.
  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    // The layout lives in localStorage (`sb.layout.v1`), which is in the Chromium
    // profile, not STARBASE_HOME — reuse it or this restarts with a blank slate
    // and proves nothing.
    userDataDir: first.userDataDir
  })
  await expect(second.window.getByText("Alpha session")).toBeVisible()
  await expect(second.window.getByTestId("session-grid")).toHaveAttribute("data-layout-mode", "2|1")
  expect(await slotSessions(second.window)).toEqual(["s_alpha", "s_beta", "s_gamma"])
})

test("a foreign drag (a file) is ignored by the grid", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()
  await window.getByTestId("layout-mode-1|1").click()

  // The composer accepts file drops; a slot must not swallow one.
  await window.evaluate(() => {
    const tgt = document.querySelector('[data-testid="grid-slot-1"]')!
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("text/plain", "hello")
    for (const type of ["dragenter", "dragover", "drop"]) {
      tgt.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }))
    }
  })

  // Still empty — nothing was assigned.
  await expect(window.getByTestId("grid-slot-empty-1")).toBeVisible()
})
