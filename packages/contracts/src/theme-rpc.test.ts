import { ThemeCatalog, ThemeError, ThemeSummary, VsCodeTheme } from "@starbase/core"
import { BUILTIN_THEMES, toTokens } from "@starbase/themes"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

/**
 * The theme payloads have to survive the main↔renderer boundary, which is
 * JSON over Electron IPC with `RpcServer`/`RpcClient` doing the encode/decode.
 *
 * That is worth its own suite because two of these schemas are shapes the rest
 * of the contract does not use: `VsCodeTheme` carries an index signature of
 * `Schema.Unknown` (to preserve keys Starbase does not model), and `ThemeTokens`
 * nests a 21-field struct for the terminal palette. Both encode fine in
 * isolation and would be caught only at runtime, in the renderer, if they did
 * not — as a settings screen that silently renders nothing.
 */

const sampleTheme = BUILTIN_THEMES.find((b) => b.id === "one-dark-pro")!.theme

describe("VsCodeTheme over the wire", () => {
  it("survives an encode/decode round trip", () => {
    const encoded = Schema.encodeSync(VsCodeTheme)(sampleTheme)
    const decoded = Schema.decodeUnknownSync(VsCodeTheme)(JSON.parse(JSON.stringify(encoded)))

    expect(decoded.name).toBe("One Dark Pro")
    expect(decoded.type).toBe("dark")
    expect(decoded.colors?.["editor.background"]).toBe("#282c34")
    expect(decoded.tokenColors?.length).toBe(sampleTheme.tokenColors?.length)
  })

  /**
   * The index signature is what stops Starbase's editor deleting the parts of a
   * user's theme it does not model. If those keys were dropped in transit
   * rather than at decode, the loss would happen on the way BACK from the
   * renderer — i.e. only when someone saves an edit, which is the worst
   * possible time to find out.
   */
  it("carries unmodelled keys across the boundary", () => {
    const rich = {
      ...sampleTheme,
      $schema: "vscode://schemas/color-theme",
      semanticTokenColors: { newOperator: "#d33682" }
    }
    const roundTripped = Schema.decodeUnknownSync(VsCodeTheme)(
      JSON.parse(JSON.stringify(Schema.encodeSync(VsCodeTheme)(rich as never)))
    )

    expect(roundTripped.$schema).toBe("vscode://schemas/color-theme")
    expect(roundTripped.semanticTokenColors).toEqual({ newOperator: "#d33682" })
  })
})

describe("ThemeCatalog over the wire", () => {
  const catalog: ThemeCatalog = {
    themes: BUILTIN_THEMES.map(
      (b): ThemeSummary => ({
        id: b.id,
        name: b.theme.name,
        kind: toTokens(b.theme).kind,
        source: "builtin",
        tokens: toTokens(b.theme)
      })
    ),
    skipped: [{ path: "/home/me/starbase/themes/broken.json", message: "type: is missing" }]
  }

  it("survives an encode/decode round trip with every built-in", () => {
    const decoded = Schema.decodeUnknownSync(ThemeCatalog)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ThemeCatalog)(catalog)))
    )
    expect(decoded.themes).toHaveLength(BUILTIN_THEMES.length)
    expect(decoded.themes[0]?.tokens.editor).toBe(catalog.themes[0]?.tokens.editor)
  })

  /** The palette is a nested struct, and xterm is unusable if a slot is lost. */
  it("keeps every terminal ANSI slot", () => {
    const decoded = Schema.decodeUnknownSync(ThemeCatalog)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ThemeCatalog)(catalog)))
    )
    const terminal = decoded.themes[0]!.tokens.terminal
    expect(Object.keys(terminal)).toHaveLength(Object.keys(catalog.themes[0]!.tokens.terminal).length)
    expect(terminal.brightWhite).toBe(catalog.themes[0]!.tokens.terminal.brightWhite)
  })

  /**
   * `skipped` is the reason listing has no error channel — it has to arrive
   * WITH the themes that did load, or the UI can only ever show one or the
   * other.
   */
  it("delivers skipped files alongside the themes that loaded", () => {
    const decoded = Schema.decodeUnknownSync(ThemeCatalog)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ThemeCatalog)(catalog)))
    )
    expect(decoded.skipped[0]?.path).toContain("broken.json")
    expect(decoded.themes.length).toBeGreaterThan(0)
  })

  it("carries the optional path only for user themes", () => {
    const withUser: ThemeCatalog = {
      themes: [{ ...catalog.themes[0]!, source: "user", path: "/tmp/themes/mine.json" }],
      skipped: []
    }
    const decoded = Schema.decodeUnknownSync(ThemeCatalog)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ThemeCatalog)(withUser)))
    )
    expect(decoded.themes[0]?.path).toBe("/tmp/themes/mine.json")
    expect(Schema.encodeSync(ThemeCatalog)(catalog).themes[0]).not.toHaveProperty("path")
  })
})

describe("ThemeError over the wire", () => {
  /**
   * A tagged error, so the renderer can branch on `_tag` rather than matching
   * on a message string. `themeId` travels because the operator is looking at a
   * grid of nine-plus swatches when this fires, and an error that does not name
   * which one costs more time than it saves.
   */
  it("keeps its tag and the id of the theme that failed", () => {
    const error = new ThemeError({ message: "Built-in themes cannot be deleted.", themeId: "monokai" })
    const decoded = Schema.decodeUnknownSync(ThemeError)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ThemeError)(error)))
    )

    expect(decoded._tag).toBe("ThemeError")
    expect(decoded.themeId).toBe("monokai")
    expect(decoded.message).toContain("cannot be deleted")
  })

  it("encodes without a themeId when the failure is not about one theme", () => {
    const error = new ThemeError({ message: "Not a VS Code theme: type: is missing" })
    const decoded = Schema.decodeUnknownSync(ThemeError)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ThemeError)(error)))
    )
    expect(decoded.themeId).toBeUndefined()
    expect(decoded._tag).toBe("ThemeError")
  })
})
