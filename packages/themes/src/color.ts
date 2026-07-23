/**
 * The colour arithmetic the mapper runs on.
 *
 * Kept separate from `map.ts` because these are pure, boring and heavily
 * exercised, while the mapper is a long table of editorial decisions. Mixing
 * them would bury the one in the other.
 *
 * Everything here works in sRGB with a straight-alpha channel. No perceptual
 * space, no OKLCH: the inputs are hand-picked designer hexes that already sit
 * where their author wanted them, and the operations we need are "step this
 * surface a little further back" and "is this legible on that". Both are
 * adequately served by sRGB mixing plus a real WCAG luminance calculation, and
 * the extra machinery would make the mapper harder to reason about without
 * moving any of the outputs somewhere a user would notice.
 */

export interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  /** 0–1. */
  readonly a: number
}

const clamp = (n: number, lo = 0, hi = 255): number => Math.min(hi, Math.max(lo, n))

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
 *
 * Returns null rather than throwing on anything else, because the input is a
 * user's theme file: a bad value must degrade to "fall through to the next
 * candidate in the chain", not take out the whole theme. The caller decides
 * what a missing colour means; this function's only job is to not lie.
 */
export const parseHex = (value: string | undefined): Rgba | null => {
  if (!value) return null
  const hex = value.trim()
  if (!hex.startsWith("#")) return null
  const body = hex.slice(1)
  const expand = (s: string) => s.split("").map((c) => c + c).join("")

  let full: string
  if (body.length === 3 || body.length === 4) full = expand(body)
  else if (body.length === 6 || body.length === 8) full = body
  else return null

  if (!/^[0-9a-fA-F]+$/.test(full)) return null

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1
  }
}

const hex2 = (n: number): string => Math.round(clamp(n)).toString(16).padStart(2, "0")

/** Back to `#rrggbb`. Alpha is dropped — use `toCss` when it matters. */
export const toHex = ({ r, g, b }: Rgba): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`

/** `rgb(r g b / a)` when translucent, `#rrggbb` when not. */
export const toCss = (c: Rgba): string =>
  c.a >= 1
    ? toHex(c)
    : `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${Number(c.a.toFixed(3))})`

/**
 * Composite `fg` over `bg`, producing an opaque colour.
 *
 * The reason this exists: VS Code themes routinely give translucent values for
 * things Starbase needs opaque. `descriptionForeground` is often `#ccccccb3`
 * and `list.hoverBackground` `#2c313a80`. Assigning those straight to a
 * `--sb-*` var that paints a SURFACE means whatever is behind the app shows
 * through — on a frameless Electron window, that is the desktop.
 */
export const over = (fg: Rgba, bg: Rgba): Rgba => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1
})

/** Linear blend. `ratio` 0 → all `from`, 1 → all `to`. */
export const mix = (from: Rgba, to: Rgba, ratio: number): Rgba => {
  const t = Math.min(1, Math.max(0, ratio))
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t
  }
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/** Toward black by `amount` (0–1). */
export const darken = (c: Rgba, amount: number): Rgba => mix(c, BLACK, amount)

/** Toward white by `amount` (0–1). */
export const lighten = (c: Rgba, amount: number): Rgba => mix(c, WHITE, amount)

/** WCAG relative luminance. */
export const luminance = ({ r, g, b }: Rgba): number => {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** True when text should be light against this background. */
export const isDark = (c: Rgba): boolean => luminance(c) < 0.4

/**
 * WCAG contrast ratio, 1–21.
 *
 * Translucent inputs are treated as opaque — composite them first if that
 * matters, because a ratio computed against a colour that is 50% see-through is
 * a number about a colour nobody will ever see.
 */
export const contrast = (a: Rgba, b: Rgba): number => {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Push `color` away from `bg` until it clears `min` contrast.
 *
 * This is what makes an imported theme *usable* rather than merely *applied*.
 * Starbase paints accents as TEXT — `text-blue` on a status row, `text-yellow`
 * on a warning — where the theme that supplied them painted them as terminal
 * output on a terminal background. Solarized Light's ANSI yellow is `#b58900`
 * on `#fdf6e3`, which is fine in a terminal and marginal as UI text on a
 * lighter panel; several themes are worse than marginal.
 *
 * Nudging in 4% steps rather than jumping to black/white keeps the author's hue
 * and saturation, which is the part of a theme people actually recognise. If 25
 * steps do not get there the colour is returned as-is: a slightly illegible
 * accent is a better outcome than a grey one, because the grey one looks
 * deliberate and hides the problem.
 */
export const ensureContrast = (color: Rgba, bg: Rgba, min: number): Rgba => {
  if (contrast(color, bg) >= min) return color
  // Move away from the background's own polarity: darken on a light ground,
  // lighten on a dark one.
  const towardDark = !isDark(bg)
  let current = color
  for (let i = 0; i < 25; i++) {
    current = towardDark ? darken(current, 0.04) : lighten(current, 0.04)
    if (contrast(current, bg) >= min) return current
  }
  return color
}

/**
 * Nudge `color` a step further from `reference` in whichever direction it is
 * already going, keeping surface ramps ordered when a theme is sparse.
 *
 * Surfaces have to stay *distinguishable*: if a theme names only
 * `editor.background`, deriving the sidebar as the same colour makes the app
 * one flat sheet with invisible structure. The magnitudes differ sharply by
 * ground — 12% darker than `#282c34` is a pleasant recession, while 12% darker
 * than `#ffffff` is a dirty grey — so callers pass ground-specific amounts.
 */
export const step = (color: Rgba, amount: number): Rgba =>
  amount >= 0 ? lighten(color, amount) : darken(color, -amount)

/** Parse, or fall back. Convenience for the mapper's long fallback chains. */
export const parseOr = (value: string | undefined, fallback: Rgba): Rgba =>
  parseHex(value) ?? fallback
