/**
 * Where a dock can actually go, given how much room the shell has.
 *
 * Pure and shared by both docks (terminal and browser preview) so they can't
 * drift apart: two panels with the same job and different collapse rules is how
 * a layout starts feeling arbitrary.
 */

export type DockSide = "bottom" | "right"

/**
 * Below this much shell width, a RIGHT dock is forced to the bottom.
 *
 * A right-docked terminal takes 300px minimum and the browser 320px, on top of
 * the sidebar. Two of them open on a 900px window left nothing for a pane at
 * all. Docking bottom costs height, which the shell has far more of — the window
 * floor is 900×600 but a display is rarely short and usually narrow.
 */
export const DOCK_RIGHT_MIN_SHELL = 1100

/**
 * The most of the row a dock may take. A dock is an accessory to the panes; past
 * this it stops reading as one and the pane starts reading as the accessory.
 */
export const MAX_DOCK_FRACTION = 0.4

/**
 * The side a dock should actually render on.
 *
 * The operator's PREFERENCE is stored separately and never overwritten by this,
 * so widening the window puts the dock back where they asked for it. A layout
 * rule that silently rewrites a stored preference makes the preference a lie.
 *
 * `shellWidth === 0` means "not measured yet" and honours the preference — the
 * alternative is every dock flicking from right to bottom and back on launch.
 */
export const effectiveDock = (preferred: DockSide, shellWidth: number): DockSide =>
  preferred === "right" && shellWidth > 0 && shellWidth < DOCK_RIGHT_MIN_SHELL ? "bottom" : preferred

/** A right-docked width, capped at `MAX_DOCK_FRACTION` of the row. */
export const clampDockWidth = (width: number, shellWidth: number): number =>
  shellWidth > 0 ? Math.min(width, Math.round(shellWidth * MAX_DOCK_FRACTION)) : width
