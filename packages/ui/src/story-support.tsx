import type { ReactNode } from "react"
import { cn } from "./lib/cn.js"
import { tierFor, WIDTH_TIER_BREAKPOINTS, WidthTierProvider, type WidthTier } from "./hooks/width-tier.js"

/**
 * Story helpers for reviewing the responsive layout.
 *
 * The whole point of this rig is that it uses a REAL box at a REAL width with a
 * REAL `WidthTierProvider`, not a faked tier value. Half the responsive
 * behaviour is CSS the tier never sees — `min-w-0`, `flex-wrap`, `truncate`,
 * `overflow-x-auto` — so a rig that only stubbed the tier would show every
 * control switching correctly while the row it sits in still overflowed.
 *
 * Lives outside `*.stories.tsx` so several story files can share it without one
 * of them owning the others' fixtures.
 */

/** The widths worth reviewing: one comfortably inside each tier, plus the floor. */
export const REVIEW_WIDTHS = [1240, 720, 500, 380] as const

/** A pane at each of the four tier boundaries, exactly — where bugs hide. */
export const BOUNDARY_WIDTHS = [
  WIDTH_TIER_BREAKPOINTS.wide,
  WIDTH_TIER_BREAKPOINTS.wide - 1,
  WIDTH_TIER_BREAKPOINTS.mid,
  WIDTH_TIER_BREAKPOINTS.mid - 1,
  WIDTH_TIER_BREAKPOINTS.narrow,
  WIDTH_TIER_BREAKPOINTS.narrow - 1
] as const

const TIER_TONE: Record<WidthTier, string> = {
  wide: "text-green",
  mid: "text-blue",
  narrow: "text-yellow",
  tiny: "text-red"
}

/**
 * One component at one width, labelled and outlined.
 *
 * `overflow-visible` on the frame is deliberate and is the reason this rig
 * catches anything: in the app a pane clips its own overflow, so a row that
 * spills is silently truncated and LOOKS like a design decision. Here it spills
 * past the dashed outline, where you can see it.
 */
export function AtWidth({
  width,
  height = 260,
  label,
  children
}: {
  width: number
  /** Fixed height so a row of samples lines up; raise it for taller screens. */
  height?: number
  /** Extra context beside the px + tier readout. */
  label?: string
  children: ReactNode
}) {
  const tier = tierFor(width)
  return (
    <div className="flex flex-none flex-col gap-1.5">
      <div className="flex items-baseline gap-2 font-mono text-[10.5px]">
        <span className="text-text-bright">{width}px</span>
        <span className={cn("uppercase tracking-[0.5px]", TIER_TONE[tier])}>{tier}</span>
        {label && <span className="text-dim">{label}</span>}
      </div>
      <div
        style={{ width, height }}
        className="flex flex-col overflow-visible rounded-[3px] border border-dashed border-line-strong bg-editor"
      >
        <WidthTierProvider className="flex-col">{children}</WidthTierProvider>
      </div>
    </div>
  )
}

/**
 * The same subtree at several widths, side by side.
 *
 * Side by side rather than one story per width: the question a reviewer is
 * actually asking is "does this degrade sensibly", which is a question about the
 * SEQUENCE. Four separate stories make you hold three of them in your head.
 */
export function WidthLadder({
  widths = REVIEW_WIDTHS,
  height,
  render
}: {
  widths?: ReadonlyArray<number>
  height?: number
  /** Rendered once per width — take a fresh subtree so state isn't shared. */
  render: (width: number) => ReactNode
}) {
  return (
    <div className="flex items-start gap-5 overflow-auto bg-canvas p-6">
      {widths.map((width) => (
        <AtWidth key={width} width={width} height={height}>
          {render(width)}
        </AtWidth>
      ))}
    </div>
  )
}

/**
 * A note above a ladder saying what to look for.
 *
 * Reviewing "is this responsive?" without a stated expectation degenerates into
 * "it looks fine" — the failure mode these stories exist to prevent.
 */
export function LookFor({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-hairline bg-panel px-6 py-3 text-[12px] leading-relaxed text-text-body">
      {children}
    </div>
  )
}
