import { describe, expect, it } from "vitest"
import type { VsCodeTheme } from "@starbase/core"
import { contrast, luminance, parseHex } from "./color.js"
import { toTokens } from "./map.js"
import { BUILTIN_THEMES } from "./presets/index.js"

const rgba = (hex: string) => parseHex(hex)!
const ratio = (a: string, b: string) => contrast(rgba(a), rgba(b))
const lum = (hex: string) => luminance(rgba(hex))

const ACCENTS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange"] as const

describe("toTokens — every built-in theme", () => {
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s resolves every token",
    (_id, theme) => {
      const tokens = toTokens(theme)
      const empty = Object.entries(tokens).filter(([, v]) => v === undefined || v === null || v === "")
      expect(empty).toEqual([])
    }
  )

  /**
   * Body text is the app's floor. A theme that applies but whose sidebar text
   * sits at 3:1 is worse than one that fails to load, because the operator
   * blames their eyes rather than the theme.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps body text readable on the panel",
    (_id, theme) => {
      const t = toTokens(theme)
      expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
    }
  )

  /**
   * Accents are chips, dots and one-word labels — the non-text 3:1 bar, not
   * body text's 4.5. Without the check, Solarized Light's ANSI yellow lands at
   * roughly 2:1 as UI text on a cream panel.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps every accent distinguishable on the panel",
    (_id, theme) => {
      const t = toTokens(theme)
      for (const accent of ACCENTS) {
        expect(ratio(t[accent], t.panel), `${accent} on panel`).toBeGreaterThanOrEqual(3)
      }
    }
  )

  /**
   * The five text tones are the type hierarchy, and Starbase renders all of
   * them inside a single sidebar row.
   *
   * Non-increasing rather than strictly decreasing, because the top of the ramp
   * legitimately saturates: High Contrast Dark and Tomorrow Night Blue both put
   * body text at `#ffffff`, and there is nothing brighter for a heading to be.
   * Manufacturing a step there would mean dimming body text below the theme's
   * own choice — on a HIGH CONTRAST theme, which is the one place that would be
   * indefensible.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s never inverts the text ramp",
    (_id, theme) => {
      const t = toTokens(theme)
      const ratios = [t.textBright, t.textBody, t.text, t.muted, t.dim].map((c) => ratio(c, t.panel))
      for (let i = 1; i < ratios.length; i++) {
        expect(ratios[i]!, `tone ${i} vs ${i - 1}`).toBeLessThanOrEqual(ratios[i - 1]!)
      }
    }
  )

  /**
   * The BOTTOM of the ramp has headroom on every theme — there is always room
   * between body text and the background — so a collapse there is a real
   * defect, not saturation. Light Modern gives `foreground` and
   * `descriptionForeground` the same `#3b3b3b`, which without the ramp pass
   * makes a timestamp indistinguishable from the label above it.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps secondary and tertiary text strictly quieter than body text",
    (_id, theme) => {
      const t = toTokens(theme)
      const body = ratio(t.text, t.panel)
      expect(ratio(t.muted, t.panel), "muted vs text").toBeLessThan(body)
      expect(ratio(t.dim, t.panel), "dim vs muted").toBeLessThan(ratio(t.muted, t.panel))
    }
  )

  /**
   * `sunken` is a WELL — terminals and code blocks are rendered into it, inside
   * panels and inside editor-backed prose. Monokai puts its selection colour
   * `#414339` in `panel.background`, so read literally the well came out
   * lighter than the panel containing it and code blocks appeared to bulge out
   * of the card rather than sink into it.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s recesses the well below both surfaces it appears in",
    (_id, theme) => {
      const t = toTokens(theme)
      if (t.kind === "high-contrast") return // flat by design; borders carry it
      expect(lum(t.sunken), "sunken vs panel").toBeLessThan(lum(t.panel))
      expect(lum(t.sunken), "sunken vs editor").toBeLessThan(lum(t.editor))
    }
  )

  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps canvas behind the panel and the panel at or behind the editor",
    (_id, theme) => {
      const t = toTokens(theme)
      if (t.kind === "high-contrast") return
      expect(lum(t.canvas)).toBeLessThan(lum(t.panel))
      expect(lum(t.panel)).toBeLessThan(lum(t.editor))
    }
  )

  it("labels each theme with the right ground", () => {
    const byId = Object.fromEntries(BUILTIN_THEMES.map((b) => [b.id, toTokens(b.theme).kind]))
    expect(byId["one-dark-pro"]).toBe("dark")
    expect(byId["light-modern"]).toBe("light")
    expect(byId["solarized-light"]).toBe("light")
    expect(byId["high-contrast-dark"]).toBe("high-contrast")
  })
})

/**
 * One Dark Pro is `DEFAULT_THEME_ID`: a fresh install runs it, every
 * pre-theming config resolves to it, and every failure falls back to it. If the
 * fold moved a single value, then "theming shipped" and "the theme failed to
 * load" would both look like the app quietly changing colour — and every
 * Storybook baseline would need rebuilding for a feature meant to be a no-op by
 * default. These are the literal values in `packages/ui/src/globals.css`.
 */
describe("toTokens — One Dark Pro is a visual no-op", () => {
  const t = toTokens(BUILTIN_THEMES.find((b) => b.id === "one-dark-pro")!.theme)

  it.each([
    ["canvas", "#16181d"],
    ["panel", "#21252b"],
    ["sunken", "#1e2228"],
    ["editor", "#282c34"],
    ["surface", "#2c313a"],
    ["hairline", "#181a1f"],
    ["line", "#3e4451"],
    ["lineStrong", "#4b5263"],
    ["textBright", "#d7dae0"],
    ["textBody", "#c8ccd4"],
    ["text", "#abb2bf"],
    ["muted", "#828997"],
    ["dim", "#5c6370"],
    ["blue", "#61afef"],
    ["green", "#98c379"],
    ["yellow", "#e5c07b"],
    ["red", "#e06c75"],
    ["purple", "#c678dd"],
    ["cyan", "#56b6c2"],
    ["orange", "#d19a66"]
  ] as const)("%s is exactly %s", (token, expected) => {
    expect(t[token].toLowerCase()).toBe(expected)
  })

  /**
   * The diff viewer is the loudest place the no-op rule could break. One Dark
   * Pro genuinely ships `diffEditor.insertedTextBackground: "#00809b33"` — a
   * TEAL insert wash — while Starbase's diff has always painted
   * `bg-green/[0.13]`. Taking the theme's own value would have recoloured every
   * diff on upgrade, so the default preset pins these four the way it pins its
   * surfaces. Other themes still get their own.
   */
  it("keeps the diff washes on the app's existing green and red", () => {
    expect(t.diffAddBg).toContain("152 195 121") // green
    expect(t.diffDelBg).toContain("224 108 117") // red
    expect(t.diffAddBg).toMatch(/0\.12\d?|0\.13/)
    expect(t.diffDelBg).toMatch(/0\.12\d?/)
  })

  /** The gutter markers are deliberately quiet, so they skip the accent bar. */
  it("keeps the dim gutter markers rather than brightening them to pass contrast", () => {
    expect(t.diffAddFg.toLowerCase()).toBe("#4e6b45")
    expect(t.diffDelFg.toLowerCase()).toBe("#6b4a4e")
  })

  it.each([
    ["scrollbar", "#3e4451"],
    ["scrollbarHover", "#4b5263"],
    ["linkHover", "#7cc0f5"]
  ] as const)("%s matches the value already in globals.css", (token, expected) => {
    expect(t[token].toLowerCase()).toBe(expected)
  })
})

describe("toTokens — sparse themes", () => {
  /**
   * High Contrast Dark, the sparsest theme we ship, sets eleven colours. Every
   * panel, border, accent and ANSI slot has to be produced from those — so this
   * is the case that proves the fallback chains carry a theme rather than
   * merely decorating one.
   */
  it("builds a full, ordered token set from only editor.background", () => {
    const sparse: VsCodeTheme = {
      name: "Sparse Dark",
      type: "dark",
      colors: { "editor.background": "#101014" }
    }
    const t = toTokens(sparse)

    expect(t.editor.toLowerCase()).toBe("#101014")
    expect(Object.values(t).every(Boolean)).toBe(true)
    expect(t.panel).not.toBe(t.editor)
    expect(t.sunken).not.toBe(t.panel)
    expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
  })

  it("builds a legible light theme from only editor.background", () => {
    const t = toTokens({ name: "Sparse Light", type: "light", colors: { "editor.background": "#ffffff" } })

    expect(t.kind).toBe("light")
    expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
    // On a light ground there is no white left to climb, so raised chrome has
    // to get DARKER. A hover state lighter than #ffffff is not available.
    expect(lum(t.surface)).toBeLessThan(lum(t.editor))
  })

  it("falls back entirely when a theme names no colours at all", () => {
    const t = toTokens({ name: "Empty", type: "dark" })
    expect(t.editor.toLowerCase()).toBe("#282c34")
    expect(Object.values(t).every(Boolean)).toBe(true)
  })
})

describe("toTokens — translucent values", () => {
  /**
   * VS Code themes give alpha freely — `descriptionForeground: "#ccccccb3"` is
   * ordinary. A translucent value assigned to a var that paints a SURFACE means
   * the desktop shows through, because the Electron window is frameless.
   */
  it("flattens a translucent sidebar onto an opaque surface", () => {
    const t = toTokens({
      name: "Translucent",
      type: "dark",
      colors: { "editor.background": "#202020", "sideBar.background": "#ffffff20" }
    })
    expect(t.panel).toMatch(/^#[0-9a-f]{6}$/i)
    expect(t.panel).not.toContain("rgb")
  })

  /**
   * Washes are the opposite case: hover and selection sit over an unknown
   * surface, so baking them opaque would make every hovered row the wrong
   * colour on the surfaces they were not baked against.
   */
  it("keeps hover and overlay translucent", () => {
    const t = toTokens(BUILTIN_THEMES[0]!.theme)
    expect(t.hover).toContain("rgb")
    expect(t.overlay).toContain("rgb")
  })
})

/**
 * Themes are user-supplied files that people download and share, and every
 * token ends up interpolated into `:root { --sb-x: <value>; }` — text that is
 * additionally injected into a `<style>` before React mounts so the first
 * paint is themed.
 *
 * So a theme is untrusted input on a path to a stylesheet. The mapper's defence
 * is that it never passes a theme's string through: every token is re-emitted
 * from parsed components. These tests pin that, keyed on the four tokens that
 * legitimately keep their alpha and so used to read the raw string.
 */
describe("toTokens — a theme is untrusted input", () => {
  const HOSTILE = "red } * { display: none } :root { --sb-panel: red"

  it.each([
    ["scrollbarSlider.background", "scrollbar"],
    ["scrollbarSlider.hoverBackground", "scrollbarHover"],
    ["diffEditor.insertedTextBackground", "diffAddBg"],
    ["diffEditor.removedTextBackground", "diffDelBg"],
    ["terminal.selectionBackground", null],
    ["editor.selectionBackground", "selection"]
  ] as const)("never lets %s escape into the stylesheet", (key, token) => {
    const t = toTokens({
      name: "Hostile",
      type: "dark",
      colors: { "editor.background": "#101010", [key]: HOSTILE }
    })
    const values = [...Object.values(t).filter((v) => typeof v === "string"), ...Object.values(t.terminal)]
    for (const value of values) {
      expect(value).not.toContain("}")
      expect(value).not.toContain("<")
      expect(value).not.toContain(";")
    }
    if (token) expect(t[token]).not.toContain("display")
  })

  it("falls back to a derived wash when the theme's value is unparseable", () => {
    const t = toTokens({
      name: "Junk",
      type: "dark",
      colors: { "editor.background": "#101010", "scrollbarSlider.background": "not-a-colour" }
    })
    expect(t.scrollbar).toMatch(/^(#[0-9a-f]{6}|rgb\()/i)
  })

  /**
   * The alpha is the whole reason these four read the theme's own value rather
   * than a derived one, so laundering must not flatten it.
   */
  it("keeps the theme's alpha on a translucent wash", () => {
    const t = toTokens({
      name: "Alpha",
      type: "dark",
      colors: { "editor.background": "#101010", "diffEditor.insertedTextBackground": "#9bb95533" }
    })
    expect(t.diffAddBg).toContain("rgb(")
    expect(t.diffAddBg).toContain("0.2")
  })
})

describe("toTokens — colour customizations", () => {
  /**
   * Overrides are merged into `colors` before the fold, not patched onto the
   * output, so they are written in VS Code's vocabulary and stay portable —
   * which is also what lets one override survive switching themes.
   */
  it("applies an override in the theme's own vocabulary", () => {
    const base = toTokens(BUILTIN_THEMES[0]!.theme)
    const overridden = toTokens(BUILTIN_THEMES[0]!.theme, { "editor.background": "#123456" })

    expect(base.editor.toLowerCase()).not.toBe("#123456")
    expect(overridden.editor.toLowerCase()).toBe("#123456")
  })

  it("still enforces the ramps over an override", () => {
    const t = toTokens(BUILTIN_THEMES[0]!.theme, { "sideBar.background": "#ffffff" })
    // A white sidebar on a dark theme is legal input; the text on it must still
    // be readable rather than the theme's original light-on-dark grey.
    expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("toTokens — terminal palette", () => {
  /**
   * Where a theme states `terminal.ansi*` we pass it through untouched, even
   * when it would fail the accent contrast bar. The author chose these for
   * exactly this use, and "correcting" them means `ls` and `git diff` stop
   * looking like they do in VS Code.
   */
  it("passes a theme's ANSI colours through verbatim", () => {
    const t = toTokens({
      name: "Ansi",
      type: "dark",
      colors: { "editor.background": "#101010", "terminal.ansiRed": "#800000" }
    })
    expect(t.terminal.red.toLowerCase()).toBe("#800000")
  })

  it("fills every ANSI slot even when a theme names none", () => {
    const t = toTokens({ name: "No Ansi", type: "dark", colors: { "editor.background": "#101010" } })
    expect(Object.values(t.terminal).every((v) => typeof v === "string" && v.length > 0)).toBe(true)
  })

  /**
   * The terminal dock is painted on `sunken`. Backing the canvas with `editor`
   * instead would make the terminal look like it floats in front of the panel
   * it lives in.
   */
  it("backs the terminal onto the recessed well, not the editor", () => {
    const t = toTokens({ name: "Plain", type: "dark", colors: { "editor.background": "#101010" } })
    expect(t.terminal.background.toLowerCase()).toBe(t.sunken.toLowerCase())
  })
})
