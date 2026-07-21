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
 * A pane entering or leaving a split.
 *
 * Animates `flexGrow` rather than `width`: the panes share a flex row, so
 * growing one must shrink its neighbours *in the same frame*. A width animation
 * would need every sibling animated in lockstep and would still fight the
 * flexbox. `0.001` rather than `0` because a flex child with zero grow snaps
 * shut instantly instead of easing.
 */
export const paneVariants: Variants = {
  hidden: { flexGrow: 0.001, opacity: 0 },
  visible: (ratio: number) => ({ flexGrow: ratio, opacity: 1, transition: SPRING }),
  exit: { flexGrow: 0.001, opacity: 0, transition: SPRING }
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
