import { describe, expect, it } from "vitest"
import { contrast, luminance, parseHex, toHex } from "./color.js"
import {
  MIN_SURFACE_STEP,
  enforceSurfaceRamp,
  enforceTextRamp,
  separate,
  withLuminance
} from "./ramp.js"

const c = (hex: string) => parseHex(hex)!

describe("withLuminance", () => {
  it("hits the requested luminance", () => {
    const result = withLuminance(c("#61afef"), 0.2)
    expect(luminance(result)).toBeCloseTo(0.2, 2)
  })

  it("can raise and lower", () => {
    expect(luminance(withLuminance(c("#101010"), 0.6))).toBeGreaterThan(luminance(c("#101010")))
    expect(luminance(withLuminance(c("#f0f0f0"), 0.2))).toBeLessThan(luminance(c("#f0f0f0")))
  })

  /**
   * Hue is the recognisable part of a theme. A Solarized whose surfaces had
   * been nudged toward neutral grey to satisfy a ratio would be correct and
   * would no longer be Solarized, so the search mixes toward black or white
   * rather than recomputing channels.
   */
  it("keeps the colour's hue family when moving it", () => {
    const blue = c("#268bd2")
    const darker = withLuminance(blue, luminance(blue) / 3)
    expect(darker.b).toBeGreaterThan(darker.r)
    expect(darker.b).toBeGreaterThan(darker.g)
  })

  it("returns the input when it already sits at the target", () => {
    const start = c("#282c34")
    expect(toHex(withLuminance(start, luminance(start)))).toBe(toHex(start))
  })

  it("clamps rather than diverging on an unreachable target", () => {
    expect(luminance(withLuminance(c("#000000"), 2))).toBeLessThanOrEqual(1)
    expect(luminance(withLuminance(c("#ffffff"), -1))).toBeGreaterThanOrEqual(0)
  })
})

describe("separate", () => {
  it("leaves a candidate that is already far enough on the right side", () => {
    const base = c("#282c34")
    const already = c("#16181d")
    expect(toHex(separate(base, already, "darker"))).toBe(toHex(already))
  })

  it("pushes a too-close candidate until it clears the step", () => {
    const base = c("#282c34")
    const tooClose = c("#282c35")
    const fixed = separate(base, tooClose, "darker")
    expect(contrast(base, fixed)).toBeGreaterThanOrEqual(MIN_SURFACE_STEP - 0.001)
    expect(luminance(fixed)).toBeLessThan(luminance(base))
  })

  /**
   * The case that matters. Monokai puts its SELECTION colour `#414339` in
   * `panel.background`, so read literally the recessed well came out lighter
   * than the panel containing it — a well that bulges outward. An inverted
   * candidate has to be reflected across the base, not merely nudged, or one
   * nudge leaves it still on the wrong side.
   */
  it("reflects a candidate that is on the wrong side entirely", () => {
    const base = c("#1e1f1c")
    const inverted = c("#414339")
    const fixed = separate(base, inverted, "darker")
    expect(luminance(fixed)).toBeLessThan(luminance(base))
  })

  it("works in the lighter direction too", () => {
    const base = c("#282c34")
    const fixed = separate(base, c("#101010"), "lighter")
    expect(luminance(fixed)).toBeGreaterThan(luminance(base))
  })

  /**
   * Below black there is nowhere left to go. Clamping rather than looping is
   * what lets High Contrast Dark — whose editor, panel and canvas are all
   * `#000000` — resolve at all instead of hanging.
   */
  it("clamps at black instead of hanging", () => {
    const fixed = separate(c("#000000"), c("#000000"), "darker")
    expect(luminance(fixed)).toBe(0)
  })
})

describe("enforceSurfaceRamp", () => {
  const flat = (hex: string) => ({
    canvas: c(hex),
    panel: c(hex),
    sunken: c(hex),
    editor: c(hex),
    surface: c(hex)
  })

  /**
   * Dark Modern paints title bar, sidebar and panel all `#181818` — faithful to
   * VS Code, where 1px borders carry the structure. Starbase renders code
   * blocks INSIDE cards, so a collapsed `sunken` makes them invisible.
   */
  it("pulls collapsed surfaces apart on a dark theme", () => {
    const r = enforceSurfaceRamp("dark", { ...flat("#181818"), editor: c("#1f1f1f") })
    expect(luminance(r.canvas)).toBeLessThan(luminance(r.panel))
    expect(luminance(r.sunken)).toBeLessThan(luminance(r.panel))
    expect(luminance(r.panel)).toBeLessThan(luminance(r.editor))
  })

  it("pulls collapsed surfaces apart on a light theme", () => {
    const r = enforceSurfaceRamp("light", { ...flat("#f8f8f8"), editor: c("#ffffff") })
    expect(luminance(r.canvas)).toBeLessThan(luminance(r.panel))
    expect(luminance(r.sunken)).toBeLessThan(luminance(r.panel))
  })

  /**
   * On a light ground there is no white left to climb, so raised chrome has to
   * get darker. Applying the dark ground's "lighter" rule would make a hovered
   * row on `#ffffff` unchanged and therefore invisible.
   */
  it("raises chrome downward on light and upward on dark", () => {
    const light = enforceSurfaceRamp("light", { ...flat("#f8f8f8"), editor: c("#ffffff") })
    expect(luminance(light.surface)).toBeLessThan(luminance(light.editor))

    const dark = enforceSurfaceRamp("dark", { ...flat("#181818"), editor: c("#1f1f1f") })
    expect(luminance(dark.surface)).toBeGreaterThan(luminance(dark.editor))
  })

  it("never moves the editor plane", () => {
    const editor = c("#272822")
    const r = enforceSurfaceRamp("dark", { ...flat("#414339"), editor })
    expect(toHex(r.editor)).toBe(toHex(editor))
  })

  /**
   * High contrast is flat black with mandated borders BY DESIGN. Lifting its
   * panel off the background would undo the accessibility property the theme
   * exists to provide, so it is exempt.
   */
  it("leaves a high-contrast theme flat", () => {
    const input = flat("#000000")
    const r = enforceSurfaceRamp("high-contrast", input)
    expect(toHex(r.panel)).toBe("#000000")
    expect(toHex(r.sunken)).toBe("#000000")
    expect(toHex(r.canvas)).toBe("#000000")
  })
})

describe("enforceTextRamp", () => {
  const panel = c("#f8f8f8")

  /**
   * Light Modern sets `foreground` and `descriptionForeground` to the same
   * `#3b3b3b`. VS Code renders those far enough apart that nobody notices;
   * Starbase renders both inside one sidebar row.
   */
  it("separates a secondary tone that collapsed into body text", () => {
    const r = enforceTextRamp(panel, {
      textBright: c("#3b3b3b"),
      textBody: c("#3b3b3b"),
      text: c("#3b3b3b"),
      muted: c("#3b3b3b"),
      dim: c("#3b3b3b")
    })
    expect(contrast(r.muted, panel)).toBeLessThan(contrast(r.text, panel))
    expect(contrast(r.dim, panel)).toBeLessThan(contrast(r.muted, panel))
  })

  /**
   * The anchor rule, and the reason the ramp is not built from the bright end.
   * `textBright` comes from `tab.activeForeground`, which several themes set
   * DIMMER than `editor.foreground` because VS Code paints it on a tab strip.
   * Cascading from that end dragged Solarized Light's body text from 4.75 to
   * 3.13 against the panel — straight through the WCAG floor the mapper had
   * just enforced.
   */
  it("never moves body text, even when the brighter tones are dimmer than it", () => {
    const text = c("#56686f")
    const r = enforceTextRamp(c("#eee8d5"), {
      textBright: c("#93a1a1"),
      textBody: c("#93a1a1"),
      text,
      muted: c("#586e75"),
      dim: c("#969a94")
    })
    expect(toHex(r.text)).toBe(toHex(text))
    expect(contrast(r.text, c("#eee8d5"))).toBeGreaterThanOrEqual(4.5)
  })

  it("pushes the brighter tones above body text when there is headroom", () => {
    const surface = c("#21252b")
    const r = enforceTextRamp(surface, {
      textBright: c("#abb2bf"),
      textBody: c("#abb2bf"),
      text: c("#abb2bf"),
      muted: c("#828997"),
      dim: c("#5c6370")
    })
    expect(contrast(r.textBody, surface)).toBeGreaterThan(contrast(r.text, surface))
    expect(contrast(r.textBright, surface)).toBeGreaterThan(contrast(r.textBody, surface))
  })

  /**
   * On a theme whose body text is already `#ffffff` there is nothing brighter
   * for a heading to be. Saturating is the right answer; the wrong one is
   * dimming body text to manufacture a step, which on High Contrast Dark would
   * mean reducing contrast on the theme that exists to maximise it.
   */
  it("saturates rather than dimming body text when the ramp hits white", () => {
    const black = c("#000000")
    const white = c("#ffffff")
    const r = enforceTextRamp(black, {
      textBright: white,
      textBody: white,
      text: white,
      muted: c("#a6a6a6"),
      dim: c("#737373")
    })
    expect(toHex(r.text)).toBe("#ffffff")
    expect(contrast(r.textBody, black)).toBeLessThanOrEqual(contrast(r.textBright, black))
    // The bottom half still has room, so it must still be ordered.
    expect(contrast(r.muted, black)).toBeLessThan(contrast(r.text, black))
  })

  it("leaves an already-ordered ramp untouched", () => {
    const surface = c("#21252b")
    const tones = {
      textBright: c("#d7dae0"),
      textBody: c("#c8ccd4"),
      text: c("#abb2bf"),
      muted: c("#828997"),
      dim: c("#5c6370")
    }
    const r = enforceTextRamp(surface, tones)
    expect(toHex(r.textBright)).toBe(toHex(tones.textBright))
    expect(toHex(r.muted)).toBe(toHex(tones.muted))
    expect(toHex(r.dim)).toBe(toHex(tones.dim))
  })
})
