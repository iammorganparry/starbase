import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The split, driven through the real built app.
 *
 * These exist because the split's bugs have all been INTERACTION bugs that unit
 * tests could not reach: a pane click destroying the native browser preview, the
 * close button blanking the whole app, a sidebar click yanking a session out of
 * the pane it was visibly sitting in. jsdom cannot see any of that — and, since
 * the split's zones are geometric (the outer eighths of a pane insert, the middle
 * replaces), neither can it see whether a drop lands where the pointer was.
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

/** Where in the target a drop lands — the three zones, by name. */
type Zone = "before" | "after" | "replace"

/**
 * Wait until the panes have stopped moving.
 *
 * The panes spring to their new widths, and everything below is geometric: a
 * drop's zone comes from where in the pane's box the pointer is, and the width
 * assertions are literally about boxes. Measuring mid-spring reads a pane that is
 * 50px wide on its way to 640, so a coordinate computed as "the middle" lands in
 * the right-hand eighth by the time the drop is handled — an insert where a
 * replace was meant. This was not a hypothetical: it failed exactly that way.
 *
 * THREE identical samples 100ms apart, not two. A spring has slow stretches —
 * both ends of it — and two consecutive reads can match inside one while the
 * pane is still 400px from where it is going. Two was the first thing tried and
 * it let exactly that through.
 */
const STABLE_SAMPLES = 3

const settle = async (page: Page) => {
  await page.evaluate(() => {
    delete (window as unknown as { __sbPanes?: { sample: string; count: number } }).__sbPanes
  })
  await page.waitForFunction(
    (needed) => {
      const sample = Array.from(document.querySelectorAll('[data-testid^="split-pane-"]'))
        .map((el) => {
          const box = el.getBoundingClientRect()
          return `${Math.round(box.left)}:${Math.round(box.width)}`
        })
        .join("|")
      const store = window as unknown as { __sbPanes?: { sample: string; count: number } }
      const previous = store.__sbPanes
      const count = previous && previous.sample === sample ? previous.count + 1 : 1
      store.__sbPanes = { sample, count }
      return count >= needed
    },
    STABLE_SAMPLES,
    { polling: 100, timeout: 5000 }
  )
}

/**
 * Perform a real HTML5 drag from one element to another, landing in `zone`.
 *
 * Playwright's `dragTo` (and any hand-driven mouse down/move/up) does NOT start
 * an HTML5 drag in Chromium — the native drag loop is outside the CDP input
 * domain, so `dragstart` never fires and the drop handlers never see a payload.
 * Dispatching the real `DragEvent`s with ONE shared `DataTransfer` is the
 * faithful alternative: our own `dragstart` handler writes the payload into it,
 * and our `dragover`/`drop` handlers read it back exactly as they would live.
 *
 * The coordinate matters here in a way it never did for the grid: the drop
 * handler picks its zone from where in the target's box the pointer is, so the
 * events carry a `clientX` measured off the real rect.
 */
const dragTo = async (
  page: Page,
  sourceTestId: string,
  targetTestId: string,
  zone: Zone = "replace"
) => {
  // The coordinate is only meaningful once the target has stopped moving.
  await settle(page)
  await page.evaluate(
    ({ source, target, where }) => {
      const src = document.querySelector(`[data-testid="${source}"]`)
      const tgt = document.querySelector(`[data-testid="${target}"]`)
      if (!src || !tgt) throw new Error(`missing drag node: ${source} → ${target}`)
      const box = tgt.getBoundingClientRect()
      // Well inside each zone rather than on its boundary: the edges are the
      // outer eighths, and a test that lands on the seam is a flake waiting.
      const fraction = where === "before" ? 0.04 : where === "after" ? 0.96 : 0.5
      const clientX = box.left + box.width * fraction
      const clientY = box.top + box.height / 2
      const dataTransfer = new DataTransfer()
      const fire = (node: Element, type: string) =>
        node.dispatchEvent(
          new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true, clientX, clientY })
        )
      fire(src, "dragstart")
      fire(tgt, "dragenter")
      fire(tgt, "dragover")
      fire(tgt, "drop")
      fire(src, "dragend")
    },
    { source: sourceTestId, target: targetTestId, where: zone }
  )
}

/**
 * Which session sits in each pane, left to right, read off the rendered split.
 *
 * Always assert on this through `expect.poll`, never a bare `await`. A closed
 * pane stays in the DOM for the length of its exit animation — that is what
 * `AnimatePresence` is for — so a snapshot taken the instant after a close still
 * counts it, and the test reads a pane that is visibly on its way out as one
 * that is still there.
 */
const paneSessions = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="split-pane-"]'))
      .map((el) => ({
        el,
        index: Number(el.getAttribute("data-testid")!.replace("split-pane-", ""))
      }))
      .sort((a, b) => a.index - b.index)
      .map(({ el }) => el.getAttribute("data-session"))
  )

test("dropping a session on a pane's edge splits it in beside", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  // One session, one pane — in this model that is a group of one, and there is
  // no empty slot anywhere to drop into. The split is CREATED by the drop.
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha"])

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")

  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])
  await expect(window.getByTestId("split-view")).toHaveAttribute("data-panes", "2")
})

test("dropping on a pane's MIDDLE replaces its session rather than splitting", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])

  // Middle of pane 1: Gamma takes Beta's place. Still two panes, not three —
  // this is the gesture the narrow edge zones exist to keep distinct.
  await dragTo(window, "session-row-s_gamma", "split-pane-1", "replace")
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_gamma"])
})

test("a split renders as ONE sidebar row with a segment per pane", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")

  // Arc's pill. Both sessions are segments of one row, and neither has a
  // standalone row left behind — a split IS one entry in the list.
  await expect(window.getByTestId("split-segment-s_alpha")).toBeVisible()
  await expect(window.getByTestId("split-segment-s_beta")).toBeVisible()
  await expect(window.getByTestId("session-row-s_alpha")).toHaveCount(0)
  await expect(window.getByTestId("session-row-s_beta")).toHaveCount(0)
  // Gamma is untouched — it was never in the split.
  await expect(window.getByTestId("session-row-s_gamma")).toBeVisible()
})

test("a session that is not on screen carries no pane badge", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")

  await expect(window.getByTestId("session-slot-badge-s_gamma")).toHaveCount(0)
})

test("dropping a session onto the split it is ALREADY in changes nothing", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])

  // Drop Alpha — already in pane 0 — onto the right edge of pane 1. The drop
  // zones mean "put it beside this one", and it already IS beside it, so this is
  // deliberately a no-op rather than a reorder (that's what Move Left / Right
  // and ⌃⇧⌥← are for). What it must never do is clone: one session drives
  // exactly one conversation actor.
  await dragTo(window, "split-segment-s_alpha", "split-pane-1", "after")

  const panes = await paneSessions(window)
  expect(panes.filter((id) => id === "s_alpha")).toHaveLength(1)
  expect(panes).toEqual(["s_alpha", "s_beta"])
})

test("a session in ANOTHER group moves into this split rather than duplicating", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  // Gamma gets its own group by being clicked, then is dragged into the split.
  await window.getByTestId("session-row-s_gamma").click()
  await window.getByTestId("split-segment-s_alpha").click()
  await dragTo(window, "session-row-s_gamma", "split-pane-1", "after")

  const panes = await paneSessions(window)
  expect(panes).toEqual(["s_alpha", "s_beta", "s_gamma"])
  // And it left its old group behind rather than living in two places.
  await expect(window.getByTestId("session-row-s_gamma")).toHaveCount(0)
})

test("closing a pane leaves the other one running and the app on screen", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")

  // Close the pane that currently has focus (the drop focused the new pane). The
  // regression this guards: `showEmpty` keyed off the FOCUSED session, so closing
  // the focused pane replaced the whole app with the first-launch screen — taking
  // the other live pane with it.
  await settle(window)
  await window.getByTestId("split-pane-1").getByTestId("close-pane").click()

  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha"])
  // The closed session is back to being its own row — no empty slot is left.
  await expect(window.getByTestId("session-row-s_beta")).toBeVisible()
  // The app shell is still here — NOT the "create a session" empty state.
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
})

test("a segment's × in the sidebar closes that pane", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await settle(window)
  // Forced: the × fades in on hover, and hovering it first would also open the
  // peek card over the thing being clicked.
  await window.getByTestId("split-close-s_alpha").click({ force: true })

  // Alpha's pane is gone; the pill collapses back to an ordinary row for Beta.
  await expect.poll(() => paneSessions(window)).toEqual(["s_beta"])
  await expect(window.getByTestId("session-row-s_alpha")).toBeVisible()
})

test("clicking a session already on screen focuses its pane instead of rearranging", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])

  // Focus is on pane 1 after the drop. Clicking Alpha's SEGMENT — Alpha being
  // visibly in pane 0 — must simply move focus there. Routing it through the
  // split path would rearrange both panes.
  await window.getByTestId("split-segment-s_alpha").click()

  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])
  await expect(window.getByTestId("split-pane-0")).toHaveAttribute("data-focused", "true")
})

/**
 * The keyboard map, in a real browser.
 *
 * The unit test in `split-shortcuts.test.ts` pins the matcher against chords
 * whose `key`/`code` pairing it asserts up front. This one takes the belief out
 * of the loop entirely: Playwright presses the physical chord and Chromium
 * decides what `key` and `code` are. That distinction is the whole reason these
 * shortcuts were broken — the first version matched `e.key` against "1" and "[",
 * which Shift turns into "!" and "{" — so it is worth one real press.
 */
test("the Arc keyboard map drives focus in a real browser", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await window.getByTestId("add-right-split").click()
  await window.getByTestId("add-right-split").click()
  await expect.poll(() => paneSessions(window)).toHaveLength(3)
  await settle(window)

  // ⌃⇧1 — jump to the first pane.
  await window.keyboard.press("Control+Shift+Digit1")
  await expect(window.getByTestId("split-pane-0")).toHaveAttribute("data-focused", "true")

  // ⌃⇧3 — and to the third.
  await window.keyboard.press("Control+Shift+Digit3")
  await expect(window.getByTestId("split-pane-2")).toHaveAttribute("data-focused", "true")

  // ⌃⇧[ — one to the left.
  await window.keyboard.press("Control+Shift+BracketLeft")
  await expect(window.getByTestId("split-pane-1")).toHaveAttribute("data-focused", "true")

  // ⌃⇧] — one to the right, and then a second press that must STOP at the end
  // rather than wrapping round to the first pane.
  await window.keyboard.press("Control+Shift+BracketRight")
  await expect(window.getByTestId("split-pane-2")).toHaveAttribute("data-focused", "true")
  await window.keyboard.press("Control+Shift+BracketRight")
  await expect(window.getByTestId("split-pane-2")).toHaveAttribute("data-focused", "true")

  // ⌃⇧W — close the focused pane; the session keeps running, so it returns to
  // the sidebar as its own row.
  await window.keyboard.press("Control+Shift+KeyW")
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])
})

test("the add-right-split placeholder adds a pane, and stops when nothing is left", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  // Two clicks, two more panes — each takes the first session not already shown.
  await window.getByTestId("add-right-split").click()
  await window.getByTestId("add-right-split").click()
  await expect(window.getByTestId("split-view")).toHaveAttribute("data-panes", "3")

  // Only three sessions exist, so a fourth click has nothing to add. The control
  // stays (the cap is four) but the split does not grow.
  await window.getByTestId("add-right-split").click()
  await expect(window.getByTestId("split-view")).toHaveAttribute("data-panes", "3")
})

test("Separate all tabs flies every pane out to its own row", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await expect(window.getByTestId("split-segment-s_beta")).toBeVisible()

  await settle(window)
  // Reached from the pill's peek card, which opens on hover.
  await window.getByTestId("split-segment-s_alpha").hover()
  await window.locator('[data-testid^="split-separate-"]').click()

  await expect(window.getByTestId("session-row-s_alpha")).toBeVisible()
  await expect(window.getByTestId("session-row-s_beta")).toBeVisible()
  await expect.poll(() => paneSessions(window)).toHaveLength(1)
})

test("the split and its sessions survive a real app restart", async ({ launchApp }) => {
  const first = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(first.window.getByText("Alpha session")).toBeVisible()

  await dragTo(first.window, "session-row-s_beta", "split-pane-0", "after")
  await dragTo(first.window, "session-row-s_gamma", "split-pane-1", "after")
  await expect.poll(() => paneSessions(first.window)).toEqual(["s_alpha", "s_beta", "s_gamma"])

  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    // The split lives in localStorage (`sb.split.v2`), which is in the Chromium
    // profile, not STARBASE_HOME — reuse it or this restarts with a blank slate
    // and proves nothing.
    userDataDir: first.userDataDir
  })
  // Asserted on the pill's segments, not on the title text: at three panes the
  // sidebar drops titles for status dots (see `compact` in `SplitRow`), so
  // "Alpha session" is deliberately nowhere on screen.
  await expect(second.window.getByTestId("split-segment-s_alpha")).toBeVisible()
  await expect(second.window.getByTestId("split-view")).toHaveAttribute("data-panes", "3")
  await expect.poll(() => paneSessions(second.window)).toEqual(["s_alpha", "s_beta", "s_gamma"])
})

test("a foreign drag (a file) is ignored by the split", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()
  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")

  // The composer accepts file drops; a pane must not swallow one.
  await window.evaluate(() => {
    const tgt = document.querySelector('[data-testid="split-pane-1"]')!
    const box = tgt.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("text/plain", "hello")
    for (const type of ["dragenter", "dragover", "drop"]) {
      tgt.dispatchEvent(
        new DragEvent(type, {
          dataTransfer,
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width * 0.04,
          clientY: box.top + box.height / 2
        })
      )
    }
  })

  // Unchanged — nothing was inserted or replaced.
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])
})

/**
 * Pane GEOMETRY, as opposed to the interaction tests above.
 *
 * These exist because of a regression the whole interaction suite sailed past:
 * the pane carried `min-h-0 min-w-0 flex-col` but no `flex-1`, so it sized to its
 * CONTENT instead of filling its column. Every drag/swap/focus/restart test still
 * passed — a pane half the height it should be holds the same sessions and
 * answers the same clicks — while the composer visibly floated in the middle of
 * an empty pane.
 *
 * So the assertions here are on measured boxes, not on behaviour. An empty
 * session is deliberately the fixture: a short transcript is the case where a
 * content-sized pane collapses most, and it is what the bug was reported on.
 */

/** The measured box of one element, via the real layout engine. */
const boxOf = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) throw new Error(`no box for ${selector}`)
  return box
}

const bottomOf = (box: { y: number; height: number }) => box.y + box.height

test("a single pane fills its container, pinning the composer to the bottom", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await settle(window)
  const view = await boxOf(window, '[data-testid="split-view"]')
  const pane = await boxOf(window, '[data-testid="split-pane-0"]')

  // The pane fills the split rather than shrinking to its (empty) transcript.
  expect(Math.abs(pane.height - view.height)).toBeLessThanOrEqual(2)

  // And the composer sits at the pane's bottom edge, not partway up it. The
  // tolerance covers the composer wrapper's own padding (pb-[18px]).
  const composer = await boxOf(window, '[data-testid="composer"]')
  expect(bottomOf(pane) - bottomOf(composer)).toBeLessThanOrEqual(30)
})

test("both panes of a two-way split fill their height and share the width", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await expect.poll(() => paneSessions(window)).toEqual(["s_alpha", "s_beta"])

  await settle(window)
  const view = await boxOf(window, '[data-testid="split-view"]')
  const first = await boxOf(window, '[data-testid="split-pane-0"]')
  const second = await boxOf(window, '[data-testid="split-pane-1"]')

  for (const pane of [first, second]) {
    expect(Math.abs(pane.height - view.height)).toBeLessThanOrEqual(2)
  }
  // A new pane splits the row evenly, so the two come out the same width. The
  // tolerance covers the divider's own two pixels.
  expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(4)

  // The second pane is the one from the bug report: freshly filled, empty
  // transcript, composer stranded at the top.
  const composer = await window.getByTestId("split-pane-1").getByTestId("composer").boundingBox()
  if (composer === null) throw new Error("no composer in pane 1")
  expect(bottomOf(second) - bottomOf(composer)).toBeLessThanOrEqual(30)
})

test("dragging the divider trades width between the two panes", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: SESSIONS })
  await expect(window.getByText("Alpha session")).toBeVisible()

  await dragTo(window, "session-row-s_beta", "split-pane-0", "after")
  await settle(window)
  const before = await boxOf(window, '[data-testid="split-pane-0"]')
  const secondBefore = await boxOf(window, '[data-testid="split-pane-1"]')

  // Pointer capture, not HTML5 drag — so a real mouse drive is the faithful
  // gesture here, unlike every drop above.
  const divider = await boxOf(window, '[data-testid="split-divider-0"]')
  const y = divider.y + divider.height / 2
  await window.mouse.move(divider.x + divider.width / 2, y)
  await window.mouse.down()
  await window.mouse.move(divider.x + divider.width / 2 + 160, y, { steps: 8 })
  await window.mouse.up()

  await settle(window)
  const after = await boxOf(window, '[data-testid="split-pane-0"]')
  const secondAfter = await boxOf(window, '[data-testid="split-pane-1"]')
  // The left pane grew by roughly the distance dragged...
  expect(after.width).toBeGreaterThan(before.width + 100)
  // ...and the two panes still add up to what they did before, so width was
  // TRADED rather than added. Compared against the panes' own total rather than
  // the row's: the row also carries the divider and the 40px "Add right split"
  // ghost panel, which are not the panes' to share.
  expect(Math.abs(after.width + secondAfter.width - (before.width + secondBefore.width))).toBeLessThanOrEqual(4)
})
