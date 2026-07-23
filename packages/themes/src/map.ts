/**
 * The fold: a VS Code theme in, Starbase's `ThemeTokens` out.
 *
 * ## Why this is a table of fallbacks and not a lookup
 *
 * VS Code names around 900 colours and no theme sets all of them. What it does
 * instead is inherit: a theme declares a `type`, and every key it omits comes
 * from VS Code's own per-type defaults. High Contrast Dark, one of the themes
 * vendored here, sets exactly ELEVEN colours — `editor.background`,
 * `editor.foreground` and nine odds and ends. Everything a Starbase panel,
 * border, accent or terminal needs has to be produced from those eleven.
 *
 * So each token below is a chain: the keys a theme might plausibly have set, in
 * descending order of how well they mean what Starbase means, ending in either
 * a derivation from an already-resolved token or the per-ground defaults table.
 * The chain is the specification. A key added to the wrong position produces a
 * theme that is subtly wrong in one place, which is much harder to notice than
 * one that is loudly wrong everywhere.
 *
 * ## Two rules the chains follow
 *
 * 1. **Surfaces resolve before anything that sits on them.** Text, borders and
 *    accents are all contrast-checked against a surface, so the surfaces have
 *    to exist first. Hence the strict top-to-bottom ordering in `toTokens`.
 *
 * 2. **Anything that becomes an opaque surface gets composited.** VS Code
 *    values carry alpha freely (`list.hoverBackground: "#2c313a80"`). Assigning
 *    that straight to `--sb-panel` means the desktop shows through a frameless
 *    Electron window. `over()` flattens; see `color.ts`.
 */
import type { ThemeKind, ThemeTokens, VsCodeTheme } from "@starbase/core"
import { normalizeThemeKind } from "@starbase/core"
import {
  contrast,
  ensureContrast,
  isDark,
  mix,
  over,
  parseHex,
  step,
  toCss,
  toHex,
  type Rgba
} from "./color.js"
import { enforceSurfaceRamp, enforceTextRamp } from "./ramp.js"

type Colors = Record<string, string>

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

/**
 * Per-ground starting points, used only when a theme names nothing usable.
 *
 * The dark row is One Dark Pro's, so a sparse dark theme degrades toward the
 * palette the app was designed against rather than toward an arbitrary grey.
 * The light and high-contrast rows are VS Code's own defaults, so a sparse
 * theme of those grounds degrades toward what its author was looking at.
 */
const DEFAULTS: Record<ThemeKind, {
  editor: string
  text: string
  blue: string
  green: string
  yellow: string
  red: string
  purple: string
  cyan: string
  orange: string
}> = {
  dark: {
    editor: "#282c34",
    text: "#abb2bf",
    blue: "#61afef",
    green: "#98c379",
    yellow: "#e5c07b",
    red: "#e06c75",
    purple: "#c678dd",
    cyan: "#56b6c2",
    orange: "#d19a66"
  },
  light: {
    editor: "#ffffff",
    text: "#3b3b3b",
    blue: "#0078d4",
    green: "#107c10",
    yellow: "#bf8803",
    red: "#e51400",
    purple: "#af00db",
    cyan: "#007377",
    orange: "#d18616"
  },
  "high-contrast": {
    editor: "#000000",
    text: "#ffffff",
    blue: "#3794ff",
    green: "#89d185",
    yellow: "#cca700",
    red: "#f48771",
    purple: "#c586c0",
    cyan: "#4ec9b0",
    orange: "#ce9178"
  }
}

/**
 * How far apart consecutive surfaces sit, per ground.
 *
 * Signs, not just magnitudes, are the interesting part. On a dark ground the
 * recessed planes go DOWN toward black and raised chrome goes UP toward white.
 * On a light ground both go down: a light theme's sidebar is grey against a
 * white editor, and so is its hover state. There is no white left to go to.
 *
 * Magnitudes are much smaller on light because the eye reads a 4% step on white
 * as clearly as a 12% step on near-black — apply dark's numbers to a light
 * theme and the sidebar comes out looking dirty rather than recessed.
 */
const SURFACE_STEPS: Record<ThemeKind, {
  panel: number
  sunken: number
  canvas: number
  surface: number
}> = {
  dark: { panel: -0.06, sunken: -0.1, canvas: -0.18, surface: 0.05 },
  light: { panel: -0.025, sunken: -0.05, canvas: -0.06, surface: -0.035 },
  "high-contrast": { panel: -0.0, sunken: -0.0, canvas: -0.0, surface: 0.12 }
}

/** First key present and parseable wins. */
const pick = (colors: Colors, ...keys: ReadonlyArray<string>): Rgba | null => {
  for (const key of keys) {
    const parsed = parseHex(colors[key])
    if (parsed) return parsed
  }
  return null
}

/** As `pick`, but flattened onto `base` so the result is safe as a surface. */
const pickOpaque = (colors: Colors, base: Rgba, ...keys: ReadonlyArray<string>): Rgba | null => {
  const found = pick(colors, ...keys)
  return found ? over(found, base) : null
}

/**
 * A translucent value, taken from the theme when it parses and derived when it
 * does not — and NEVER passed through as the theme's raw string.
 *
 * This is a laundering step, not a convenience. Every token ends up
 * interpolated into `:root { --sb-x: <value>; }` by `css.ts`, and that text is
 * additionally injected into a `<style>` before React mounts so the first
 * paint is themed. A theme file is user-supplied and shareable — people will
 * download them — so a value like
 *
 *     "scrollbarSlider.background": "red } * { display: none } :root {"
 *
 * would rewrite the entire stylesheet, and one containing `</style>` would
 * escape the element altogether in the main-process boot path.
 *
 * Every other token is already safe because it round-trips through `parseHex` →
 * `toHex`. These four were the only ones reading a raw string, because they are
 * the only ones that legitimately keep their alpha. Parsing and re-emitting
 * costs nothing and means `css.ts` can never be handed a string the mapper did
 * not itself construct.
 */
const wash = (raw: string | undefined, fallback: Rgba): string => {
  const parsed = parseHex(raw)
  return toCss(parsed ?? fallback)
}

/**
 * Minimum contrast an accent must clear against the surface it is read on.
 *
 * 3.0, not 4.5. Accents here are chips, status dots, single-word labels and
 * icons — WCAG's large-text and non-text thresholds — and holding them to the
 * body-text bar would drag every theme's palette toward muddy over-corrected
 * versions of itself. Body text has its own, stricter check below.
 */
const ACCENT_MIN_CONTRAST = 3
const TEXT_MIN_CONTRAST = 4.5

/**
 * Fold a VS Code theme down to the values `:root` needs.
 *
 * `overrides` is `config.theme.colorCustomizations` — VS Code's
 * `workbench.colorCustomizations` in miniature. It merges into `colors` BEFORE
 * the fold rather than being applied to the output, so an override is written
 * in the same vocabulary as the theme it modifies and survives switching
 * themes, exactly as it does in VS Code.
 */
export const toTokens = (theme: VsCodeTheme, overrides?: Colors): ThemeTokens => {
  const colors: Colors = { ...(theme.colors ?? {}), ...(overrides ?? {}) }
  const kind = normalizeThemeKind(theme.type)
  const defaults = DEFAULTS[kind]
  const steps = SURFACE_STEPS[kind]

  // ── Surfaces ───────────────────────────────────────────────────────────────
  // Resolved first, because everything below is contrast-checked against one.

  const editor = pick(colors, "editor.background") ?? parseHex(defaults.editor)!

  // `enforceSurfaceRamp` then puts these back in order. It is not a safety net
  // bolted on after the fact — several themes genuinely invert or collapse
  // these planes because VS Code's layout does not need them separated. See
  // `ramp.ts` for the three concrete cases.
  const { canvas, panel, sunken, surface } = enforceSurfaceRamp(kind, {
    editor,
    panel:
      pickOpaque(colors, editor, "sideBar.background", "activityBar.background") ??
      step(editor, steps.panel),
    sunken:
      pickOpaque(colors, editor, "panel.background", "terminal.background", "dropdown.background") ??
      step(editor, steps.sunken),
    canvas:
      pickOpaque(colors, editor, "titleBar.activeBackground", "editorGroupHeader.tabsBackground") ??
      step(editor, steps.canvas),
    surface:
      pickOpaque(colors, editor, "list.hoverBackground", "toolbar.hoverBackground", "input.background") ??
      step(editor, steps.surface)
  })

  // ── Text ramp ──────────────────────────────────────────────────────────────

  const textRaw = pick(colors, "editor.foreground", "foreground") ?? parseHex(defaults.text)!
  // Body text is checked against `panel`, not `editor`: sidebars and cards are
  // where most of the app's small text actually lives.
  const baseText = ensureContrast(over(textRaw, panel), panel, TEXT_MIN_CONTRAST)

  // Muted and dim are *deliberately* not held to the body-text bar: they exist
  // to recede. Enforcing 4.5 on them would collapse the ramp into three shades
  // of one colour and destroy the hierarchy it is for. `enforceTextRamp` then
  // guarantees the five tones stay strictly ordered even when the theme gave
  // two of them the same value (Light Modern does exactly that).
  const { textBright, textBody, text, muted, dim } = enforceTextRamp(panel, {
    textBright:
      pickOpaque(colors, panel, "tab.activeForeground", "list.activeSelectionForeground", "titleBar.activeForeground") ??
      mix(baseText, isDark(panel) ? WHITE : BLACK, 0.3),
    textBody: pickOpaque(colors, panel, "foreground") ?? mix(baseText, isDark(panel) ? WHITE : BLACK, 0.12),
    text: baseText,
    muted:
      pickOpaque(colors, panel, "descriptionForeground", "tab.inactiveForeground") ??
      mix(baseText, panel, 0.35),
    dim:
      pickOpaque(colors, panel, "editorLineNumber.foreground", "disabledForeground") ??
      mix(baseText, panel, 0.55)
  })

  // ── Borders ────────────────────────────────────────────────────────────────

  const hairline =
    pickOpaque(colors, panel, "editorGroup.border", "sideBar.border", "panel.border") ??
    step(panel, kind === "light" ? -0.06 : -0.25)

  const line =
    pickOpaque(colors, panel, "panel.border", "input.border", "editorWidget.border", "contrastBorder") ??
    mix(panel, text, 0.18)

  const lineStrong =
    pickOpaque(colors, panel, "contrastBorder", "focusBorder", "menu.border") ?? mix(line, text, 0.3)

  // ── Accents ────────────────────────────────────────────────────────────────
  // Terminal ANSI first: it is the only place a theme states a *palette* rather
  // than a role, so it is the closest thing to "what this theme calls red".

  const accent = (fallback: string, ...keys: ReadonlyArray<string>): Rgba =>
    ensureContrast(over(pick(colors, ...keys) ?? parseHex(fallback)!, panel), panel, ACCENT_MIN_CONTRAST)

  const blue = accent(defaults.blue, "terminal.ansiBlue", "textLink.foreground", "focusBorder", "button.background")
  const green = accent(defaults.green, "terminal.ansiGreen", "gitDecoration.addedResourceForeground", "editorGutter.addedBackground")
  const yellow = accent(defaults.yellow, "terminal.ansiYellow", "editorWarning.foreground", "gitDecoration.modifiedResourceForeground")
  const red = accent(defaults.red, "terminal.ansiRed", "errorForeground", "editorError.foreground", "gitDecoration.deletedResourceForeground")
  const purple = accent(defaults.purple, "terminal.ansiMagenta", "debugTokenExpression.name")
  const cyan = accent(defaults.cyan, "terminal.ansiCyan", "editorInfo.foreground")
  const orange = accent(defaults.orange, "terminal.ansiBrightYellow", "editorWarning.foreground")

  // ── Effects ────────────────────────────────────────────────────────────────
  // Derived from the ground, never read from the theme. A scrim's job is to
  // kill the contrast of what is behind it, and no theme states a colour whose
  // meaning is that; the closest keys (`widget.shadow`) mean something else.

  const dark = isDark(editor)
  const overlay = kind === "high-contrast"
    ? "rgb(0 0 0 / 0.72)"
    : dark
      ? "rgb(0 0 0 / 0.55)"
      : "rgb(15 23 42 / 0.32)"
  const shadow = dark ? "rgb(0 0 0 / 0.45)" : "rgb(15 23 42 / 0.12)"
  const shadowStrong = dark ? "rgb(0 0 0 / 0.62)" : "rgb(15 23 42 / 0.22)"
  // Hover is a wash over an *unknown* surface, so it must stay translucent —
  // baking it opaque would make every hovered row the wrong colour on three of
  // the five surfaces it appears on.
  const hover = dark ? "rgb(255 255 255 / 0.055)" : "rgb(0 0 0 / 0.045)"

  const selectionRaw = pick(colors, "editor.selectionBackground", "selection.background")
  const selection = selectionRaw
    ? toCss(selectionRaw.a < 1 ? selectionRaw : { ...selectionRaw, a: 0.45 })
    : toCss({ ...blue, a: 0.3 })

  const scrollbar = wash(colors["scrollbarSlider.background"], { ...line, a: 0.85 })
  const scrollbarHover = wash(colors["scrollbarSlider.hoverBackground"], { ...lineStrong, a: 0.95 })

  // ── Diff ───────────────────────────────────────────────────────────────────
  // A wash, not a fill: the syntax tokens have to stay readable on top, which
  // is the whole reason `diff/highlight.ts` exists.

  const diffAddBg = wash(
    colors["diffEditor.insertedTextBackground"] ?? colors["diffEditor.insertedLineBackground"],
    { ...green, a: dark ? 0.13 : 0.18 }
  )
  const diffDelBg = wash(
    colors["diffEditor.removedTextBackground"] ?? colors["diffEditor.removedLineBackground"],
    { ...red, a: dark ? 0.12 : 0.17 }
  )

  /**
   * The gutter's `+` and `-` markers, and NOT run through the accent contrast
   * bar. They are deliberately quiet — the wash behind the line already says
   * "added", so a marker loud enough to pass a 3:1 UI-text check competes with
   * the code it is annotating. Same reasoning as `muted`/`dim` above.
   */
  const diffAddFg = over(pick(colors, "gitDecoration.addedResourceForeground") ?? green, panel)
  const diffDelFg = over(pick(colors, "gitDecoration.deletedResourceForeground") ?? red, panel)

  // VS Code names this, so prefer the theme's own answer over lifting `blue`.
  const linkHover =
    pickOpaque(colors, panel, "textLink.activeForeground") ??
    mix(blue, isDark(panel) ? WHITE : BLACK, 0.3)

  return {
    kind,

    canvas: toHex(canvas),
    panel: toHex(panel),
    sunken: toHex(sunken),
    editor: toHex(editor),
    surface: toHex(surface),
    hairline: toHex(hairline),
    line: toHex(line),
    lineStrong: toHex(lineStrong),

    textBright: toHex(textBright),
    textBody: toHex(textBody),
    text: toHex(text),
    muted: toHex(ensureContrast(muted, panel, 2.2)),
    dim: toHex(ensureContrast(dim, panel, 2.2)),

    blue: toHex(blue),
    green: toHex(green),
    yellow: toHex(yellow),
    red: toHex(red),
    purple: toHex(purple),
    cyan: toHex(cyan),
    orange: toHex(orange),

    overlay,
    shadow,
    shadowStrong,
    selection,
    hover,

    diffAddBg,
    diffDelBg,
    diffAddFg: toHex(diffAddFg),
    diffDelFg: toHex(diffDelFg),

    scrollbar,
    scrollbarHover,

    linkHover: toHex(linkHover),

    terminal: toTerminalPalette(colors, {
      sunken,
      text,
      blue,
      green,
      yellow,
      red,
      purple,
      cyan,
      orange,
      line,
      lineStrong,
      textBright,
      selection
    })
  }
}

/**
 * xterm's palette.
 *
 * The terminal renders to a canvas and takes its own object, so none of this
 * becomes a CSS var. It backs onto `sunken` rather than `editor` because that
 * is the surface the terminal dock actually sits on — matching `editor` would
 * make the terminal look like it was floating in front of its own panel.
 *
 * Where a theme states `terminal.ansi*` we use it verbatim, including colours
 * that would fail the accent contrast check: this IS a terminal, the author
 * chose these for exactly this use, and second-guessing them would mean
 * programs whose output is colour-coded stop matching what the same program
 * looks like in VS Code.
 */
const toTerminalPalette = (
  colors: Colors,
  t: {
    sunken: Rgba
    text: Rgba
    blue: Rgba
    green: Rgba
    yellow: Rgba
    red: Rgba
    purple: Rgba
    cyan: Rgba
    orange: Rgba
    line: Rgba
    lineStrong: Rgba
    textBright: Rgba
    selection: string
  }
): ThemeTokens["terminal"] => {
  const bg = pickOpaque(colors, t.sunken, "terminal.background") ?? t.sunken
  const fg = pickOpaque(colors, bg, "terminal.foreground") ?? t.text
  const ansi = (key: string, fallback: Rgba): string => toHex(pick(colors, key) ?? fallback)

  return {
    background: toHex(bg),
    foreground: toHex(fg),
    cursor: toHex(pick(colors, "terminalCursor.foreground", "editorCursor.foreground") ?? t.blue),
    cursorAccent: toHex(pick(colors, "terminalCursor.background") ?? bg),
    // Laundered like the CSS washes even though xterm takes a JS object rather
    // than a stylesheet — a value that only happens to be safe because of where
    // it currently lands is one refactor away from not being.
    selectionBackground: wash(colors["terminal.selectionBackground"], parseHex(t.selection) ?? t.line),

    black: ansi("terminal.ansiBlack", t.line),
    red: ansi("terminal.ansiRed", t.red),
    green: ansi("terminal.ansiGreen", t.green),
    yellow: ansi("terminal.ansiYellow", t.yellow),
    blue: ansi("terminal.ansiBlue", t.blue),
    magenta: ansi("terminal.ansiMagenta", t.purple),
    cyan: ansi("terminal.ansiCyan", t.cyan),
    white: ansi("terminal.ansiWhite", t.text),

    brightBlack: ansi("terminal.ansiBrightBlack", t.lineStrong),
    brightRed: ansi("terminal.ansiBrightRed", t.red),
    brightGreen: ansi("terminal.ansiBrightGreen", t.green),
    brightYellow: ansi("terminal.ansiBrightYellow", t.orange),
    brightBlue: ansi("terminal.ansiBrightBlue", t.blue),
    brightMagenta: ansi("terminal.ansiBrightMagenta", t.purple),
    brightCyan: ansi("terminal.ansiBrightCyan", t.cyan),
    brightWhite: ansi("terminal.ansiBrightWhite", t.textBright)
  }
}

/** Re-exported so tests and the settings editor can score a candidate colour. */
export { contrast, parseHex }
