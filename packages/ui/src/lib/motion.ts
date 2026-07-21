import type { Transition, Variants } from "motion/react"

/**
 * The app's motion vocabulary — one spring, one easing, and the variants built
 * from them.
 *
 * Centralised because motion only reads as *design* when everything moves with
 * the same physics: a pane that springs while the sidebar pill it came from
 * eases reads as two features rather than one gesture. Anything animating a
 * position, size or presence should reach for `SPRING`; anything animating pure
 * opacity or colour should reach for `FAST`.
 *
 * Reduced motion is NOT handled here. It's handled once, at the `MotionConfig`
 * in `app-shell` (and in the Storybook preview), with `reducedMotion="user"` —
 * which makes every transform and layout animation instant while leaving opacity
 * fades alone. Per-component checks would be four places to forget.
 */

/**
 * The workhorse. Tuned to settle in roughly 260ms with no visible overshoot:
 * panes carry a transcript, and a bouncy pane makes text you're reading wobble.
 * Under-damped springs are for toys; this is a tool.
 */
export const SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 38,
  mass: 0.9
}

/**
 * A slightly looser spring for things that carry no text — the peek card, the
 * drop-zone highlight — where a little life is welcome.
 */
export const SPRING_SOFT: Transition = {
  type: "spring",
  stiffness: 340,
  damping: 30,
  mass: 0.8
}

/** For fades and colour: fast enough to feel instant, slow enough to be seen. */
export const FAST: Transition = { duration: 0.14, ease: [0.2, 0, 0, 1] }

/**
 * No animation at all — the value is written on the frame it changes.
 *
 * For the case where the POINTER is the animation: while a divider is being
 * dragged, the pane widths are already following the cursor at pointer rate, and
 * any spring on top of that can only lag it.
 */
export const INSTANT: Transition = { duration: 0 }

/**
 * A pane entering, leaving, or resizing within a split.
 *
 * Animates `flexGrow` rather than `width`: the panes share a flex row, so
 * growing one must shrink its neighbours *in the same frame*. A width animation
 * would need every sibling animated in lockstep and would still fight the
 * flexbox. `0.001` rather than `0` because a flex child with zero grow snaps
 * shut instantly instead of easing.
 *
 * **`visible` deliberately carries no `transition` of its own**, so the caller's
 * `transition` prop governs it. A transition declared inside a variant outranks
 * the component's, which made this the second half of a bug: `visible` is a
 * function of the ratio, so every divider pointer-move re-resolved it and
 * started a fresh spring toward the new `flexGrow`. Suspending `layout` mid-drag
 * — the fix that was there — only ever addressed the other half, and the pane
 * went on trailing the pointer through a ~260ms spring: precisely the elastic
 * feel the suspension existed to prevent. `split-view` now hands down `INSTANT`
 * while a divider is down and `SPRING` the rest of the time.
 *
 * `exit` keeps its own, because a leaving pane is unmounting and has no caller
 * left to inherit from.
 */
export const paneVariants: Variants = {
  hidden: { flexGrow: 0.001, opacity: 0 },
  visible: (ratio: number) => ({ flexGrow: ratio, opacity: 1 }),
  exit: { flexGrow: 0.001, opacity: 0, transition: SPRING },
  /**
   * The entry state for a pane that arrives by a chat SWITCH rather than by an
   * edit to the split — already the right width, only not yet visible.
   *
   * `hidden` describes a pane being inserted into a split you are looking at:
   * it should push its neighbours aside, because that is what happened. A switch
   * is not that. Nothing was inserted — the whole row was replaced — so growing
   * the new pane out of a sliver animates a rearrangement that never occurred,
   * and the app reads as if it dismantled a split and built another one every
   * time you clicked a session in the sidebar.
   */
  swap: (ratio: number) => ({ flexGrow: ratio, opacity: 0 })
}

/**
 * The sidebar peek card — Arc's hover summary of a split's tabs.
 *
 * Scales from just-under rather than from zero: a card that grows from nothing
 * reads as a popup, while one that settles the last 4% reads as it was already
 * there and you just noticed it.
 */
export const peekVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: SPRING_SOFT },
  exit: { opacity: 0, scale: 0.98, y: -2, transition: FAST }
}

/**
 * How long to hover a split row before its peek card appears, in ms.
 *
 * Long enough that dragging the pointer across the sidebar doesn't strobe cards
 * at you, short enough that a deliberate hover feels answered.
 */
export const PEEK_DELAY_MS = 260
