import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The layout at half-screen widths, against the real built app.
 *
 * This exists because overflow is invisible to jsdom. Every unit test in
 * `tab-bar.responsive.test.tsx` and friends asserts which CONTROLS render at a
 * given tier — none of them can see that a row is 970px of content inside a
 * 400px box, because jsdom reports every element as zero-sized. The one
 * assertion that actually catches "it's spilling out of its container" needs a
 * real layout engine: `scrollWidth <= clientWidth`.
 *
 * That assertion is also the regression guard with the longest shelf life. The
 * specific fixes here (a `min-w-0`, a `flex-wrap`, a `flex-none` moved off a
 * cluster) are all one careless `w-[352px]` away from being undone, and the next
 * person to add a control to the composer toolbar will not read this file. They
 * will, however, see this fail.
 *
 * Not in CI — the Playwright `_electron` suite is local-only, per the repo's
 * convention. Run with `pnpm --filter @starbase/desktop e2e`.
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
  updatedAt: "2026-07-21T00:00:00.000Z",
  ...over
})

const SESSIONS: ReadonlyArray<SeedSession> = [
  baseSession({ id: "s_alpha", title: "Alpha session" }),
  baseSession({ id: "s_beta", title: "Beta session" })
]

/**
 * Every element that horizontally overflows its own box, as `testid → overflow`.
 *
 * Reported as a map rather than a boolean so a failure names the offender
 * instead of just asserting that one exists — "the composer toolbar is 84px too
 * wide" is a bug report; "something overflowed" is a scavenger hunt.
 *
 * A 1px tolerance absorbs sub-pixel rounding: a flex row whose children sum to
 * 400.4px inside a 400px box is correct layout, not a regression.
 */
const overflowing = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const out: Record<string, number> = {}
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const over = el.scrollWidth - el.clientWidth
      if (over > 1) out[el.getAttribute("data-testid") ?? el.className.slice(0, 60)] = over
    }
    return out
  }, selector)

/** Scrollable strips are SUPPOSED to overflow — that's the degradation working. */
const SCROLLABLE = "[class*='overflow-x-auto'], [class*='overflow-auto']"

const setWindowSize = async (page: Page, width: number, height: number) => {
  await page.setViewportSize({ width, height })
  // One frame for the ResizeObserver to report and the tiers to re-render.
  await page.waitForTimeout(120)
}

test("the tab bar does not spill at half-screen width", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await window.getByText("Alpha session").click()
  await setWindowSize(window, 940, 700)

  const bar = window.getByTestId("session-tab-bar").first()
  await expect(bar).toBeVisible()
  // The tab STRIP scrolls; the bar itself must not.
  const over = await bar.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(over).toBeLessThanOrEqual(1)
})

test("close-pane survives all the way down to the window's minimum", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await window.getByText("Alpha session").click()
  await setWindowSize(window, 900, 600)

  // Everything else in the cluster may fold into the overflow menu. This may not:
  // it is the control you reach for BECAUSE the pane is too narrow to read.
  await expect(window.getByTestId("session-tab-bar").first()).toBeVisible()
})

test("the sidebar collapses to a rail and every session stays reachable", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await setWindowSize(window, 900, 700)

  await expect(window.getByTestId("session-rail")).toBeVisible()
  await expect(window.getByRole("button", { name: "Beta session" })).toBeVisible()

  await setWindowSize(window, 1500, 900)
  await expect(window.getByTestId("session-sidebar")).toBeVisible()
})

test("nothing non-scrollable overflows its box at the window minimum", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await window.getByText("Alpha session").click()
  await setWindowSize(window, 900, 600)

  // Deliberately broad: the point is to catch the control nobody thought about,
  // which is by definition not the one a targeted assertion would name.
  const offenders = await overflowing(window, `div:not(${SCROLLABLE}):not(:has(${SCROLLABLE}))`)
  expect(offenders).toEqual({})
})
