import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  CSS_VAR_BY_TOKEN,
  DEFAULT_THEME_ID,
  ThemeTokens,
  VsCodeTheme,
  isDarkType,
  normalizeThemeKind,
  themeIdFromName
} from "./theme.js"

/**
 * A realistic slice of a marketplace theme: the keys Starbase reads, plus keys
 * it does not model (`$schema`, `semanticTokenColors`, `editorGutter.*`). The
 * unmodelled ones are the point of most of these tests.
 */
const MARKETPLACE_THEME = {
  $schema: "vscode://schemas/color-theme",
  name: "Solarized Dark",
  type: "dark",
  semanticHighlighting: true,
  colors: {
    "editor.background": "#002b36",
    "editor.foreground": "#839496",
    "sideBar.background": "#00212b",
    "terminal.ansiRed": "#dc322f",
    "editorGutter.addedBackground": "#859900"
  },
  semanticTokenColors: { newOperator: "#d33682" },
  tokenColors: [
    { name: "Comment", scope: "comment", settings: { foreground: "#586e75", fontStyle: "italic" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#2aa198" } }
  ]
}

describe("VsCodeTheme", () => {
  it("decodes a real marketplace theme", () => {
    const theme = Schema.decodeUnknownSync(VsCodeTheme)(MARKETPLACE_THEME)
    expect(theme.name).toBe("Solarized Dark")
    expect(theme.type).toBe("dark")
    expect(theme.colors?.["editor.background"]).toBe("#002b36")
    expect(theme.tokenColors).toHaveLength(2)
  })

  /**
   * The one that protects the user's file. Effect's `Struct` strips unnamed
   * keys by default, so without the index signature, opening a theme in
   * Starbase's editor and saving it would silently delete everything Starbase
   * does not model — and the user would find out in VS Code, later.
   */
  it("preserves keys Starbase does not model, through a full round trip", () => {
    const decoded = Schema.decodeUnknownSync(VsCodeTheme)(MARKETPLACE_THEME)
    const reencoded = Schema.encodeSync(VsCodeTheme)(decoded)

    expect(reencoded.$schema).toBe("vscode://schemas/color-theme")
    expect(reencoded.semanticTokenColors).toEqual({ newOperator: "#d33682" })
    // Even an unmodelled key inside a modelled record survives.
    expect(reencoded.colors?.["editorGutter.addedBackground"]).toBe("#859900")
  })

  it("accepts both spellings of a token rule's scope", () => {
    const theme = Schema.decodeUnknownSync(VsCodeTheme)(MARKETPLACE_THEME)
    expect(theme.tokenColors?.[0]?.scope).toBe("comment")
    expect(theme.tokenColors?.[1]?.scope).toEqual(["string", "constant.other.symbol"])
  })

  it("accepts a theme that names nothing but its ground", () => {
    const theme = Schema.decodeUnknownSync(VsCodeTheme)({ name: "Sparse", type: "light" })
    expect(theme.colors).toBeUndefined()
    expect(theme.tokenColors).toBeUndefined()
  })

  it("rejects a theme with no type", () => {
    expect(() => Schema.decodeUnknownSync(VsCodeTheme)({ name: "Nameless" })).toThrow()
  })

  it("rejects an unknown ground", () => {
    expect(() =>
      Schema.decodeUnknownSync(VsCodeTheme)({ name: "Weird", type: "sepia" })
    ).toThrow()
  })
})

describe("normalizeThemeKind", () => {
  it.each([
    ["dark", "dark"],
    ["light", "light"],
    ["hc", "high-contrast"],
    ["hcDark", "high-contrast"],
    ["hcLight", "high-contrast"]
  ] as const)("folds %s to %s", (type, kind) => {
    expect(normalizeThemeKind(type)).toBe(kind)
  })
})

describe("isDarkType", () => {
  /**
   * `normalizeThemeKind` deliberately loses the polarity of high contrast, so
   * anything that needs to know "light text or dark text" has to ask this.
   */
  it.each([
    ["dark", true],
    ["hc", true],
    ["hcDark", true],
    ["light", false],
    ["hcLight", false]
  ] as const)("%s is dark: %s", (type, dark) => {
    expect(isDarkType(type)).toBe(dark)
  })
})

describe("CSS_VAR_BY_TOKEN", () => {
  /**
   * The table is hand-written, so nothing stops a new token being added to
   * `ThemeTokens` and forgotten here — which shows up as a colour that silently
   * never applies. This test is the thing that catches it.
   */
  it("names a CSS var for every colour token", () => {
    const fields = Object.keys(ThemeTokens.fields).filter(
      (key) => key !== "kind" && key !== "terminal"
    )
    expect(Object.keys(CSS_VAR_BY_TOKEN).sort()).toEqual(fields.sort())
  })

  it("emits only --sb-* names, and no duplicates", () => {
    const vars = Object.values(CSS_VAR_BY_TOKEN)
    expect(vars.every((v) => v.startsWith("--sb-"))).toBe(true)
    expect(new Set(vars).size).toBe(vars.length)
  })

  /** `hairline` keeps the older `--sb-border` name the shipped CSS already uses. */
  it("keeps the legacy name for hairline", () => {
    expect(CSS_VAR_BY_TOKEN.hairline).toBe("--sb-border")
  })
})

describe("themeIdFromName", () => {
  it.each([
    ["Solarized Dark", "solarized-dark"],
    ["Dark+ (default dark)", "dark-default-dark"],
    ["  Monokai  ", "monokai"],
    ["Tomorrow Night Blue", "tomorrow-night-blue"]
  ])("%s → %s", (name, id) => {
    expect(themeIdFromName(name)).toBe(id)
  })

  /** A name of pure punctuation would otherwise produce an empty filename. */
  it("never returns an empty id", () => {
    expect(themeIdFromName("!!!")).toBe("theme")
    expect(themeIdFromName("")).toBe("theme")
  })

  it("caps the length so it stays a usable filename", () => {
    expect(themeIdFromName("a".repeat(200)).length).toBe(64)
  })
})

describe("DEFAULT_THEME_ID", () => {
  it("is One Dark Pro — the palette the design system was drawn against", () => {
    expect(DEFAULT_THEME_ID).toBe("one-dark-pro")
  })
})
