import { describe, expect, it } from "vitest"
import { isPaintableRect } from "./browser-preview-bounds.js"

/**
 * The bounds guard for the native `WebContentsView`.
 *
 * Worth its own suite because the failure mode is invisible from the code: too
 * high a floor and the overlay silently FREEZES at stale bounds, painting over
 * whatever is above the dock, and it only reproduces once you drag the dock near
 * its minimum. Nothing about the symptom points at the constant that caused it.
 */
describe("isPaintableRect", () => {
  it("skips a rect from a hidden or unmounted placeholder", () => {
    expect(isPaintableRect({ width: 0, height: 0 })).toBe(false)
    expect(isPaintableRect({ width: 640, height: 0 })).toBe(false)
    expect(isPaintableRect({ width: 0, height: 480 })).toBe(false)
  })

  it("skips a negative rect", () => {
    // getBoundingClientRect can report negative dimensions mid-transition.
    expect(isPaintableRect({ width: -10, height: 200 })).toBe(false)
  })

  it("skips a non-finite rect rather than forwarding NaN to setBounds", () => {
    expect(isPaintableRect({ width: Number.NaN, height: 200 })).toBe(false)
    expect(isPaintableRect({ width: 200, height: Number.POSITIVE_INFINITY })).toBe(false)
  })

  it("accepts the view region at the bottom dock's MINIMUM height", () => {
    // This is the regression. The dock's floor is 180px (HEIGHT.min in
    // `browser-preview.tsx`); the address bar takes 36 and the two borders 2,
    // leaving 142. An earlier 200×150 floor rejected exactly this, so dragging
    // the dock to its own minimum froze the native view at its previous, larger
    // bounds — permanently, and over unrelated UI.
    expect(isPaintableRect({ width: 900, height: 142 })).toBe(true)
  })

  it("accepts the view region at the right dock's MINIMUM width", () => {
    // WIDTH.min is 320; the region spans the dock's full width less its border.
    expect(isPaintableRect({ width: 319, height: 600 })).toBe(true)
  })

  it("accepts anything genuinely laid out, however small", () => {
    // The guard asks "is this laid out at all", not "is this big enough to be
    // worth showing". Nothing legitimate measures 8×8, and a small dock is
    // entitled to a small native view.
    expect(isPaintableRect({ width: 8, height: 8 })).toBe(true)
  })
})
