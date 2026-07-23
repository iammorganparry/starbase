/**
 * Enforces the two orderings Starbase's layout depends on, after the mapper has
 * read whatever the theme happened to say.
 *
 * ## Why a second pass exists at all
 *
 * The fallback chains in `map.ts` answer "what did this theme call its
 * sidebar?". They cannot answer "is the result still a coherent set of
 * surfaces?", because themes are written for VS Code's layout and mean subtly
 * different things by the same keys. Running the vendored nine through the
 * chains alone produced three distinct failures, none of which is a bug in the
 * chains:
 *
 * - **Monokai** puts `#414339` — its SELECTION colour — in `panel.background`.
 *   Read literally, the recessed well Starbase renders terminals and code
 *   blocks into came out *lighter* than the panel containing it. A well that
 *   bulges outward.
 * - **Dark Modern** paints title bar, sidebar and panel all `#181818`. Faithful
 *   to VS Code, where borders carry the structure — but it collapses `canvas`,
 *   `panel` and `sunken` to one value, so a code block inside a card becomes
 *   invisible.
 * - **Light Modern** sets `descriptionForeground` to the same `#3b3b3b` as
 *   `foreground`, collapsing `muted` into `text` and flattening the five-step
 *   type hierarchy into two.
 *
 * Each is a theme being internally consistent for a layout Starbase does not
 * have. So the fix belongs here, applied uniformly, rather than as special
 * cases smuggled into the chains.
 *
 * ## What is deliberately NOT enforced
 *
 * High contrast is exempt. Its whole design is flat black with mandated
 * borders, and "separate these surfaces" would be actively wrong — the
 * separation is supposed to come from the 1px `contrastBorder`, and lifting the
 * panel off the background would undo the accessibility property the theme
 * exists to provide.
 *
 * Hue is never touched, only lightness. The recognisable part of a theme is its
 * hue; a Solarized whose surfaces had been nudged toward neutral grey to satisfy
 * a ratio would be correct and would no longer be Solarized.
 */
import { contrast, luminance, mix, type Rgba } from "./color.js"

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/**
 * The smallest contrast ratio between two surfaces that still reads as a step.
 *
 * 1.045 — roughly `#ffffff` against `#f8f8f8`, which is what VS Code's own
 * light themes use to separate a sidebar from an editor. Anything less and the
 * boundary is carried entirely by the border.
 */
export const MIN_SURFACE_STEP = 1.045

/**
 * Rebuild `c` at a target luminance, keeping its hue by mixing toward black or
 * white rather than recomputing channels.
 *
 * Binary search because luminance is not linear in the mix ratio — the sRGB
 * transfer function means a 50% mix toward black lands nowhere near half the
 * luminance. Twenty iterations resolves to well under a perceptible step.
 */
export const withLuminance = (c: Rgba, targetL: number): Rgba => {
  const current = luminance(c)
  const target = Math.min(1, Math.max(0, targetL))
  if (Math.abs(current - target) < 0.0005) return c

  const toward = target < current ? BLACK : WHITE
  let lo = 0
  let hi = 1
  let best = c
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2
    best = mix(c, toward, t)
    const l = luminance(best)
    if (Math.abs(l - target) < 0.0005) return best
    // Mixing toward black lowers luminance monotonically, toward white raises
    // it — so which half to keep depends on the direction of travel.
    if (toward === BLACK ? l > target : l < target) lo = t
    else hi = t
  }
  return best
}

/**
 * Return `candidate` if it sits at least `minRatio` away from `base` in
 * `direction`; otherwise a version of `candidate` moved until it does.
 *
 * `direction` is where the candidate belongs relative to the base — `"darker"`
 * for a recessed plane, `"lighter"` for raised chrome on a dark ground. A
 * candidate on the WRONG side is not merely too close: it is inverted, and gets
 * reflected across the base rather than nudged, which is what turns Monokai's
 * bulging well back into a well.
 */
export const separate = (
  base: Rgba,
  candidate: Rgba,
  direction: "darker" | "lighter",
  minRatio = MIN_SURFACE_STEP
): Rgba => {
  const baseL = luminance(base)
  const candL = luminance(candidate)
  const rightSide = direction === "darker" ? candL <= baseL : candL >= baseL

  if (rightSide && contrast(base, candidate) >= minRatio) return candidate

  // The luminance that sits exactly `minRatio` away on the correct side.
  // Derived from the WCAG formula: (L1 + 0.05) / (L2 + 0.05) = ratio.
  const targetL =
    direction === "darker"
      ? (baseL + 0.05) / minRatio - 0.05
      : (baseL + 0.05) * minRatio - 0.05

  // Below black or above white there is nowhere left to go — accept the clamp
  // and let the border carry the boundary, exactly as high contrast does.
  return withLuminance(candidate, Math.min(1, Math.max(0, targetL)))
}

/**
 * Force the five text tones into a strictly descending contrast ramp against
 * the surface they are read on.
 *
 * The ramp is the type hierarchy: a heading has to outrank body text has to
 * outrank a timestamp. Themes routinely give two of these the same value —
 * `foreground` and `descriptionForeground` are identical in Light Modern —
 * because VS Code renders them in places far enough apart that nobody notices.
 * Starbase renders all five within one sidebar row.
 *
 * Collapsed entries are rebuilt by pulling the weaker tone toward the
 * background, which is the direction "less important" already means, so the
 * repair is invisible where the ramp was fine and legible where it was not.
 */
export const enforceTextRamp = (
  surface: Rgba,
  tones: { textBright: Rgba; textBody: Rgba; text: Rgba; muted: Rgba; dim: Rgba },
  /** Minimum contrast-ratio gap between adjacent tones. */
  gap = 1.12
): typeof tones => {
  /**
   * `text` is the anchor, and everything else moves around it.
   *
   * The obvious implementation — walk brightest to dimmest, pull each tone
   * below the one before it — is wrong, and wrong in a way that only shows up
   * on real themes. `textBright` comes from `tab.activeForeground`, which
   * several themes set DIMMER than `editor.foreground` (VS Code renders it on a
   * tab strip, not as a heading). Cascading from that end drags `text` down
   * behind it: Solarized Light lost its body text from 4.75 to 3.13 against the
   * panel, i.e. straight through the WCAG floor the mapper had just enforced.
   *
   * So: `text` holds — it is the only tone with a hard accessibility bar — and
   * the ramp is built outward. Brighter tones are pushed AWAY from the surface,
   * quieter ones pulled TOWARD it. Nothing can push `text` anywhere.
   *
   * The upward half saturates on some themes and that is correct. High Contrast
   * Dark and Tomorrow Night Blue both set body text to `#ffffff`, so a heading
   * has nowhere brighter to go and `textBright`, `textBody` and `text` all land
   * on white. The alternative — dimming body text to make room for a heading —
   * would mean reducing contrast on a high-contrast theme, which is the one
   * place it could not be defended. The downward half never saturates, because
   * there is always room between text and its own background, so a collapse
   * THERE is a real defect and the tests treat it as one.
   */
  const away = (tone: Rgba, minRatio: number): Rgba => {
    let fixed = tone
    const target = luminance(surface) > 0.4 ? BLACK : WHITE
    for (let n = 0; n < 24 && contrast(fixed, surface) < minRatio; n++) {
      fixed = mix(fixed, target, 0.06)
    }
    return fixed
  }

  const toward = (tone: Rgba, maxRatio: number): Rgba => {
    let fixed = tone
    for (let n = 0; n < 24 && contrast(fixed, surface) > maxRatio; n++) {
      fixed = mix(fixed, surface, 0.08)
    }
    return fixed
  }

  const textRatio = contrast(tones.text, surface)

  // Upward from the anchor: each must out-contrast the one below it.
  const textBody = away(tones.textBody, textRatio * gap)
  const textBright = away(tones.textBright, contrast(textBody, surface) * gap)

  // Downward from the anchor: each must be quieter than the one above it.
  const muted = toward(tones.muted, textRatio / gap)
  const dim = toward(tones.dim, contrast(muted, surface) / gap)

  return { textBright, textBody, text: tones.text, muted, dim }
}

/**
 * Put the five surfaces back in order: canvas and sunken behind panel, panel at
 * or behind editor, surface raised in front of it.
 *
 * `sunken` is separated from BOTH panel and editor because it is used inside
 * each — a terminal sits in a panel, a code block sits in editor-backed prose —
 * and matching either one makes the well vanish in that context.
 *
 * On a light ground "raised" is still darker: white is the ceiling, so a
 * hovered row can only get dimmer. That asymmetry is why `surface` takes a
 * direction while the recessed planes do not.
 */
export const enforceSurfaceRamp = (
  kind: "dark" | "light" | "high-contrast",
  s: { canvas: Rgba; panel: Rgba; sunken: Rgba; editor: Rgba; surface: Rgba }
): typeof s => {
  // High contrast is flat by design; separating its planes would undo the
  // property it exists for.
  if (kind === "high-contrast") return s

  const panel = separate(s.editor, s.panel, "darker")
  const sunken = separate(panel, separate(s.editor, s.sunken, "darker"), "darker")
  const canvas = separate(panel, s.canvas, "darker")
  const surface = separate(s.editor, s.surface, kind === "light" ? "darker" : "lighter")

  return { canvas, panel, sunken, editor: s.editor, surface }
}
