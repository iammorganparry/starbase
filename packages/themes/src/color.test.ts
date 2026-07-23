import { describe, expect, it } from "vitest"
import {
  contrast,
  darken,
  ensureContrast,
  lighten,
  luminance,
  mix,
  over,
  parseHex,
  step,
  toCss,
  toHex,
  type Rgba
} from "./color.js"

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

describe("parseHex", () => {
  it("reads #rgb as its expanded form", () => {
    expect(parseHex("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 })
  })

  it("reads #rrggbb", () => {
    expect(parseHex("#282c34")).toEqual({ r: 40, g: 44, b: 52, a: 1 })
  })

  it("reports alpha as 0–1 rather than 0–255", () => {
    expect(parseHex("#282c34cc")?.a).toBeCloseTo(0.8, 3)
    expect(parseHex("#abcf")?.a).toBe(1)
    expect(parseHex("#00000000")?.a).toBe(0)
  })

  it("expands the alpha nibble of #rgba the same way as the colour nibbles", () => {
    expect(parseHex("#abcd")).toEqual(parseHex("#aabbccdd"))
  })

  it("ignores surrounding whitespace", () => {
    expect(parseHex("  #282c34  ")).toEqual(parseHex("#282c34"))
  })

  it("treats hex digits as case-insensitive", () => {
    expect(parseHex("#ABB2BF")).toEqual(parseHex("#abb2bf"))
  })

  /**
   * The mapper's fallback chains are `pick(colors, "a", "b") ?? derive(...)` —
   * they lean on this returning null. A throw here would mean one typo'd swatch
   * in a user's theme file takes out the entire theme rather than falling
   * through to the next candidate.
   */
  it("returns null instead of throwing for anything it cannot read", () => {
    expect(parseHex(undefined)).toBeNull()
    expect(parseHex("")).toBeNull()
    expect(parseHex("   ")).toBeNull()
    expect(parseHex("282c34")).toBeNull()
    expect(parseHex("rgb(40 44 52)")).toBeNull()
    expect(parseHex("#")).toBeNull()
    expect(parseHex("#12")).toBeNull()
    expect(parseHex("#12345")).toBeNull()
    expect(parseHex("#1234567")).toBeNull()
    expect(parseHex("#123456789")).toBeNull()
    expect(parseHex("#gggggg")).toBeNull()
    expect(parseHex("#xyz")).toBeNull()
    expect(parseHex("#28 c34")).toBeNull()
  })
})

describe("toHex / toCss", () => {
  it("round-trips an opaque colour", () => {
    expect(toHex(parseHex("#61afef")!)).toBe("#61afef")
  })

  it("drops alpha from toHex", () => {
    expect(toHex(parseHex("#61afef80")!)).toBe("#61afef")
  })

  it("emits #rrggbb when the colour is opaque", () => {
    expect(toCss({ r: 97, g: 175, b: 239, a: 1 })).toBe("#61afef")
  })

  it("emits rgb(r g b / a) when the colour is translucent", () => {
    expect(toCss({ r: 255, g: 0, b: 0, a: 0.5 })).toBe("rgb(255 0 0 / 0.5)")
    expect(toCss(parseHex("#282c34cc")!)).toBe("rgb(40 44 52 / 0.8)")
  })

  it("rounds fractional channels produced by mixing", () => {
    expect(toHex(mix(BLACK, WHITE, 0.5))).toBe("#808080")
  })
})

describe("over", () => {
  /**
   * VS Code themes hand Starbase translucent values for slots that paint
   * SURFACES — `list.hoverBackground: "#2c313a80"` becoming `--sb-panel`. On a
   * frameless Electron window a translucent surface shows the user's desktop
   * through the app, so compositing must always yield an opaque result.
   */
  it("composites a half-transparent white over black to mid grey", () => {
    const result = over({ r: 255, g: 255, b: 255, a: 0.5 }, BLACK)
    expect(toHex(result)).toBe("#808080")
    expect(result.a).toBe(1)
  })

  it("always produces an opaque colour, even from a fully transparent input", () => {
    expect(over({ r: 255, g: 0, b: 0, a: 0 }, BLACK)).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(over({ r: 255, g: 0, b: 0, a: 0.2 }, WHITE).a).toBe(1)
  })

  it("leaves an already-opaque foreground alone", () => {
    expect(over({ r: 97, g: 175, b: 239, a: 1 }, BLACK)).toEqual({ r: 97, g: 175, b: 239, a: 1 })
  })
})

describe("mix", () => {
  it("returns each endpoint at ratio 0 and 1", () => {
    expect(mix(BLACK, WHITE, 0)).toEqual(BLACK)
    expect(mix(BLACK, WHITE, 1)).toEqual(WHITE)
  })

  it("clamps ratios outside 0–1 to the endpoints", () => {
    expect(mix(BLACK, WHITE, 5)).toEqual(WHITE)
    expect(mix(BLACK, WHITE, -5)).toEqual(BLACK)
  })

  it("interpolates alpha alongside the colour channels", () => {
    expect(mix({ r: 0, g: 0, b: 0, a: 0 }, WHITE, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 0.5 })
  })
})

describe("lighten / darken", () => {
  it("reaches white and black at amount 1", () => {
    expect(lighten(parseHex("#61afef")!, 1)).toEqual(WHITE)
    expect(darken(parseHex("#61afef")!, 1)).toEqual(BLACK)
  })

  it("is a no-op at amount 0", () => {
    const blue = parseHex("#61afef")!
    expect(lighten(blue, 0)).toEqual(blue)
    expect(darken(blue, 0)).toEqual(blue)
  })

  it("moves luminance in the named direction", () => {
    const base = parseHex("#61afef")!
    expect(luminance(lighten(base, 0.2))).toBeGreaterThan(luminance(base))
    expect(luminance(darken(base, 0.2))).toBeLessThan(luminance(base))
  })

  it("clamps over-large amounts rather than overshooting past white or black", () => {
    expect(lighten(parseHex("#61afef")!, 4)).toEqual(WHITE)
    expect(darken(parseHex("#61afef")!, 4)).toEqual(BLACK)
  })
})

describe("luminance / contrast", () => {
  it("puts black at 0 and white at 1", () => {
    expect(luminance(BLACK)).toBe(0)
    expect(luminance(WHITE)).toBeCloseTo(1, 5)
  })

  it("rates white on black as the maximum 21", () => {
    expect(contrast(WHITE, BLACK)).toBeCloseTo(21, 5)
  })

  it("rates a colour against itself as 1", () => {
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5)
    expect(contrast(parseHex("#282c34")!, parseHex("#282c34")!)).toBeCloseTo(1, 5)
  })

  it("does not depend on the order of its arguments", () => {
    const fg = parseHex("#abb2bf")!
    const bg = parseHex("#282c34")!
    expect(contrast(fg, bg)).toBeCloseTo(contrast(bg, fg), 10)
  })
})

describe("ensureContrast", () => {
  it("returns the colour untouched when it already clears the threshold", () => {
    const text = parseHex("#abb2bf")!
    const bg = parseHex("#282c34")!
    expect(ensureContrast(text, bg, 4.5)).toEqual(text)
  })

  /**
   * Starbase paints theme accents as TEXT (a `text-yellow` warning label) where
   * the theme painted them as terminal output. Without this lift, Solarized
   * Light's `#b58900` on a light panel and several worse offenders ship as
   * barely-readable UI text.
   */
  it("lightens a too-dark colour on a dark background until it passes", () => {
    const bg = parseHex("#282c34")!
    const tooDark = parseHex("#3a3f4b")!
    const fixed = ensureContrast(tooDark, bg, 4.5)

    expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5)
    expect(luminance(fixed)).toBeGreaterThan(luminance(tooDark))
  })

  it("darkens a too-light colour on a light background until it passes", () => {
    const bg = parseHex("#ffffff")!
    const tooLight = parseHex("#e8e8e8")!
    const fixed = ensureContrast(tooLight, bg, 4.5)

    expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5)
    expect(luminance(fixed)).toBeLessThan(luminance(tooLight))
  })

  it("keeps the author's hue while lifting an accent", () => {
    const bg = parseHex("#fdf6e3")!
    const yellow = parseHex("#b58900")!
    const fixed = ensureContrast(yellow, bg, 4.5)

    expect(fixed.r).toBeGreaterThan(fixed.g)
    expect(fixed.g).toBeGreaterThan(fixed.b)
  })

  /**
   * The loop is bounded at 25 steps precisely so an unreachable target cannot
   * hang the mapper — and every theme import runs the mapper on the main
   * process before a window exists.
   */
  it("gives up and returns the input when the target is unreachable", () => {
    const grey = parseHex("#808080")!
    expect(ensureContrast(grey, grey, 21)).toEqual(grey)
    expect(ensureContrast(WHITE, WHITE, 21)).toEqual(WHITE)
  })
})

describe("step", () => {
  it("lightens on a positive amount and darkens on a negative one", () => {
    const base = parseHex("#282c34")!
    expect(luminance(step(base, 0.12))).toBeGreaterThan(luminance(base))
    expect(luminance(step(base, -0.12))).toBeLessThan(luminance(base))
  })

  it("matches lighten and darken for the equivalent amount", () => {
    const base = parseHex("#282c34")!
    expect(step(base, 0.12)).toEqual(lighten(base, 0.12))
    expect(step(base, -0.12)).toEqual(darken(base, 0.12))
  })

  it("is a no-op at zero", () => {
    const base = parseHex("#282c34")!
    expect(step(base, 0)).toEqual(base)
  })
})
