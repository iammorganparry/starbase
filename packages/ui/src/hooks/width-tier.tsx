import * as React from "react"
import { cn } from "../lib/cn.js"
import { useContainerWidth } from "./use-container-width.js"

/**
 * How much room a container has, expressed as a name rather than a number so
 * components don't each invent their own threshold.
 *
 * - `wide`   — the layout as designed: full labels, inline actions, docked rails.
 * - `mid`    — decorative affordances go (keyboard hints, secondary labels).
 * - `narrow` — structure changes: icon-only tabs, wrapped toolbars, rails float.
 * - `tiny`   — one column, overflow menus, essentials only.
 */
export type WidthTier = "tiny" | "narrow" | "mid" | "wide"

export const WIDTH_TIER_BREAKPOINTS = { wide: 780, mid: 560, narrow: 400 } as const

export const tierFor = (width: number): WidthTier =>
  width >= WIDTH_TIER_BREAKPOINTS.wide
    ? "wide"
    : width >= WIDTH_TIER_BREAKPOINTS.mid
      ? "mid"
      : width >= WIDTH_TIER_BREAKPOINTS.narrow
        ? "narrow"
        : "tiny"

const ORDER: Record<WidthTier, number> = { tiny: 0, narrow: 1, mid: 2, wide: 3 }

/** `atLeast(tier, "mid")` — true when there's at least `min` worth of room. */
export const atLeast = (tier: WidthTier, min: WidthTier) => ORDER[tier] >= ORDER[min]

type PaneWidth = { width: number; tier: WidthTier }

/**
 * Defaults to `wide` so a component rendered outside any provider (Storybook,
 * a unit test, a dialog portalled to the body) keeps today's full layout rather
 * than silently collapsing to icons.
 */
const PaneWidthContext = React.createContext<PaneWidth>({ width: 0, tier: "wide" })

/**
 * Measures its own box and publishes the resulting tier to everything beneath it.
 *
 * Nested providers are intentional and cheap: the split row provides a tier for
 * dock decisions, each pane provides its own for tab-bar/composer decisions, and
 * a child always sees the nearest — i.e. the container that actually constrains it.
 */
export function WidthTierProvider({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}) {
  const [ref, width] = useContainerWidth()

  const value = React.useMemo<PaneWidth>(
    // Width 0 means "not measured yet", not "zero pixels". Reporting `tiny` for
    // the first paint would flash an icon-only tab bar on every mount before
    // the observer's first frame lands.
    () => ({ width, tier: width === 0 ? "wide" : tierFor(width) }),
    [width]
  )

  return (
    <PaneWidthContext.Provider value={value}>
      <div ref={ref} className={cn("flex min-h-0 min-w-0 flex-1", className)}>
        {children}
      </div>
    </PaneWidthContext.Provider>
  )
}

/**
 * Publishes a tier without rendering a measuring box — for callers that already
 * have the width (a dock whose px size they control, or a test harness).
 */
export function WidthTierValue({
  width,
  children
}: {
  width: number
  children: React.ReactNode
}) {
  const value = React.useMemo<PaneWidth>(
    () => ({ width, tier: width === 0 ? "wide" : tierFor(width) }),
    [width]
  )
  return <PaneWidthContext.Provider value={value}>{children}</PaneWidthContext.Provider>
}

export const useWidthTier = () => React.useContext(PaneWidthContext).tier
export const usePaneWidth = () => React.useContext(PaneWidthContext)

/** Renders `children` only when the container has at least `min` room. */
export function AtLeast({ min, children }: { min: WidthTier; children: React.ReactNode }) {
  return atLeast(useWidthTier(), min) ? <>{children}</> : null
}

/** Renders `children` only when the container is BELOW `min` — the inverse of `AtLeast`. */
export function Below({ min, children }: { min: WidthTier; children: React.ReactNode }) {
  return atLeast(useWidthTier(), min) ? null : <>{children}</>
}
