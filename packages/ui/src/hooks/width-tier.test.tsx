import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { atLeast, tierFor, useWidthTier, WIDTH_TIER_BREAKPOINTS, WidthTierValue } from "./width-tier.js"

afterEach(cleanup)

describe("tierFor", () => {
  it("names each band", () => {
    expect(tierFor(1440)).toBe("wide")
    expect(tierFor(700)).toBe("mid")
    expect(tierFor(450)).toBe("narrow")
    expect(tierFor(300)).toBe("tiny")
  })

  it("treats each breakpoint as inclusive of the wider band", () => {
    // Pinned because an off-by-one here is invisible in the UI until a pane
    // lands exactly on a boundary and flickers between two layouts.
    expect(tierFor(WIDTH_TIER_BREAKPOINTS.wide)).toBe("wide")
    expect(tierFor(WIDTH_TIER_BREAKPOINTS.wide - 1)).toBe("mid")
    expect(tierFor(WIDTH_TIER_BREAKPOINTS.mid)).toBe("mid")
    expect(tierFor(WIDTH_TIER_BREAKPOINTS.mid - 1)).toBe("narrow")
    expect(tierFor(WIDTH_TIER_BREAKPOINTS.narrow)).toBe("narrow")
    expect(tierFor(WIDTH_TIER_BREAKPOINTS.narrow - 1)).toBe("tiny")
  })
})

describe("atLeast", () => {
  it("orders the tiers", () => {
    expect(atLeast("wide", "mid")).toBe(true)
    expect(atLeast("mid", "mid")).toBe(true)
    expect(atLeast("narrow", "mid")).toBe(false)
    expect(atLeast("tiny", "narrow")).toBe(false)
  })
})

function Probe() {
  return <span data-testid="tier">{useWidthTier()}</span>
}

describe("useWidthTier", () => {
  it("defaults to wide with no provider, so an unmeasured subtree keeps the full layout", () => {
    render(<Probe />)
    expect(screen.getByTestId("tier").textContent).toBe("wide")
  })

  it("reads an unmeasured width (0) as wide, not tiny", () => {
    // The first paint always reports 0 — before the ResizeObserver's first
    // frame. Reading that as `tiny` would flash an icon-only layout on mount.
    render(
      <WidthTierValue width={0}>
        <Probe />
      </WidthTierValue>
    )
    expect(screen.getByTestId("tier").textContent).toBe("wide")
  })

  it("takes the NEAREST provider, so a narrow pane inside a wide shell reads narrow", () => {
    render(
      <WidthTierValue width={1600}>
        <WidthTierValue width={420}>
          <Probe />
        </WidthTierValue>
      </WidthTierValue>
    )
    expect(screen.getByTestId("tier").textContent).toBe("narrow")
  })
})
