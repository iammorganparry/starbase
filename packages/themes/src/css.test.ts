import { CSS_VAR_BY_TOKEN } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { THEME_STYLE_ID, toCssText } from "./css.js"
import { toTokens } from "./map.js"
import { highContrastDark } from "./presets/high-contrast-dark.js"
import { lightModern } from "./presets/light-modern.js"
import { oneDarkPro } from "./presets/one-dark-pro.js"

const dark = toTokens(oneDarkPro)
const light = toTokens(lightModern)
const highContrast = toTokens(highContrastDark)

describe("toCssText", () => {
  it("wraps the declarations in a :root block", () => {
    const css = toCssText(dark)
    expect(css.startsWith(":root {\n")).toBe(true)
    expect(css.endsWith("}\n")).toBe(true)
  })

  /**
   * `globals.css` ships a `:root` fallback for every `--sb-*` var, and this
   * sheet is appended after it at equal specificity. Any var this block omits
   * silently keeps the previous theme's value — so a theme switch would leave
   * one stray colour from the theme the user just left.
   */
  it("declares every var in CSS_VAR_BY_TOKEN with that token's value", () => {
    const css = toCssText(dark)
    for (const [token, cssVar] of Object.entries(CSS_VAR_BY_TOKEN)) {
      const value = dark[token as keyof typeof CSS_VAR_BY_TOKEN]
      expect(css).toContain(`  ${cssVar}: ${value};`)
    }
  })

  it("declares each var exactly once", () => {
    const css = toCssText(dark)
    for (const cssVar of Object.values(CSS_VAR_BY_TOKEN)) {
      expect(css.split(`${cssVar}:`)).toHaveLength(2)
    }
  })

  it("exposes the theme's ground as --sb-theme-kind", () => {
    expect(toCssText(dark)).toContain("--sb-theme-kind: dark;")
    expect(toCssText(light)).toContain("--sb-theme-kind: light;")
    expect(toCssText(highContrast)).toContain("--sb-theme-kind: high-contrast;")
  })

  /**
   * `color-scheme` is what themes the browser's own chrome — the caret, native
   * scrollbars, date pickers. Get it wrong on a light theme and every input in
   * the app gets a dark caret on a white field.
   */
  it("sets color-scheme to light only for a light theme", () => {
    expect(toCssText(light)).toContain("color-scheme: light;")
    expect(toCssText(dark)).toContain("color-scheme: dark;")
    expect(toCssText(highContrast)).toContain("color-scheme: dark;")
  })

  it("emits no var for the tokens that are not CSS colours", () => {
    const css = toCssText(dark)
    expect(css).not.toContain("--sb-terminal")
    expect(css).not.toContain("--sb-kind")
  })

  it("emits no undefined values for a fully resolved theme", () => {
    expect(toCssText(dark)).not.toContain("undefined")
  })
})

describe("THEME_STYLE_ID", () => {
  it("names the element shared by the pre-paint injector and ThemeProvider", () => {
    expect(THEME_STYLE_ID).toBe("starbase-theme")
  })
})
