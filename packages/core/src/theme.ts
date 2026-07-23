/**
 * Theming — the VS Code theme format, and what Starbase folds it down to.
 *
 * ## Why the VS Code format is the stored format
 *
 * Themes are a thing people already own. An operator arriving with a favourite
 * has it as a VS Code theme JSON — from a marketplace extension, a gist, or the
 * `.vscode/` directory of a repo. Inventing a Starbase-shaped theme file would
 * mean every one of those needs hand-translating before it can be used, which
 * in practice means nobody brings one.
 *
 * So `VsCodeTheme` below IS the file on disk, verbatim, unknown keys and all.
 * The lossy step happens later and in one place: `@starbase/themes`'s mapper
 * folds the ~40 keys Starbase can act on down to `ThemeTokens`. VS Code names
 * around 900 colours, most of them for surfaces Starbase does not have (no
 * minimap, no breadcrumbs, no editor gutter), and pretending to model them
 * would be a lie told in 900 lines of schema.
 *
 * Unknown keys survive decoding (see the index signature on `VsCodeTheme`)
 * rather than being stripped, so a theme that round-trips through Starbase's
 * editor comes back out still usable in VS Code. Lossy in the renderer is fine;
 * lossy on disk destroys the user's file.
 *
 * ## Why `ThemeTokens` is small and flat
 *
 * `packages/ui/src/globals.css` already puts every colour behind a `--sb-*`
 * custom property and re-exports it to Tailwind through `@theme inline`. Every
 * component in the app therefore speaks `bg-panel` / `text-blue` /
 * `border-line` and NOT hex. `ThemeTokens` is exactly the set of values that
 * `:root` block needs — one field per var, nothing more — so applying a theme
 * is a single stylesheet rewrite and no component has to know themes exist.
 *
 * Adding a token means touching three places, in this order: this struct, the
 * `:root` fallback + `@theme inline` block in `globals.css`, and the mapper's
 * fallback chain in `@starbase/themes`. Miss the third and the token is
 * `undefined` for every imported theme.
 */
import { Schema } from "effect"

// ── Colour primitives ────────────────────────────────────────────────────────

/**
 * A hex colour, as VS Code writes them: `#rgb`, `#rrggbb`, or `#rrggbbaa`.
 *
 * Validated rather than left as `Schema.String` because the failure mode of a
 * bad colour is silent — CSS drops an invalid custom property value and the
 * element inherits, so one typo'd swatch in an imported theme shows up as a
 * mysteriously transparent panel three screens away rather than as an error.
 */
export const HexColor = Schema.String.pipe(
  Schema.pattern(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    identifier: "HexColor",
    description: "a hex colour such as #282c34 or #282c34cc"
  })
)
export type HexColor = Schema.Schema.Type<typeof HexColor>

/**
 * A CSS colour expression — hex, or `rgb(…)` / `rgba(…)` in either notation.
 *
 * Used for the tokens Starbase DERIVES rather than reads: scrims, shadows and
 * selection washes are `rgb(… / …)` because they must sit translucently over
 * whatever surface they land on, and baking them to an opaque hex would make
 * them wrong the moment a panel changed colour.
 *
 * The pattern is narrow ON PURPOSE, and is the second of two defences rather
 * than the first. Every one of these values is interpolated into
 * `:root { --sb-x: <value>; }`, and that text is additionally inlined into a
 * `<style>` element in the boot HTML so the first paint is themed. Themes are
 * user-supplied files that people download and share, so a value of
 * `red } * { display: none } :root {` would rewrite the whole stylesheet and
 * one containing `</style>` would escape the element entirely. The mapper
 * already re-emits every token from parsed components rather than passing a
 * theme's string through; this makes a future caller that forgets fail loudly
 * at the schema boundary instead of silently shipping an injection.
 */
export const CssColor = Schema.String.pipe(
  Schema.pattern(/^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([0-9.,%\s/]+\))$/, {
    identifier: "CssColor",
    description: "a hex colour or an rgb()/rgba() expression"
  })
)
export type CssColor = Schema.Schema.Type<typeof CssColor>

// ── The VS Code theme file ───────────────────────────────────────────────────

/**
 * How a theme describes its own ground. `hc` is the legacy spelling of
 * `hcDark`; both still appear in the wild, so both decode.
 */
export const VsCodeThemeType = Schema.Literal("dark", "light", "hc", "hcDark", "hcLight")
export type VsCodeThemeType = Schema.Schema.Type<typeof VsCodeThemeType>

/**
 * The three grounds Starbase actually branches on, after `VsCodeThemeType` is
 * normalised. Collapsing five spellings to three here means the mapper's
 * defaults table and the light-mode CSS both have one thing to switch on.
 */
export const ThemeKind = Schema.Literal("dark", "light", "high-contrast")
export type ThemeKind = Schema.Schema.Type<typeof ThemeKind>

/** `hc` and `hcDark` are the same ground; `hcLight` is its own. */
export const normalizeThemeKind = (type: VsCodeThemeType): ThemeKind =>
  type === "light" ? "light" : type === "dark" ? "dark" : "high-contrast"

/**
 * Whether a kind wants light-on-dark. High contrast comes in both flavours, but
 * `hcLight` normalises to `high-contrast` too, so callers that only need the
 * polarity should ask `VsCodeTheme.type` rather than the normalised kind.
 */
export const isDarkType = (type: VsCodeThemeType): boolean => type !== "light" && type !== "hcLight"

/**
 * One TextMate rule from a theme's `tokenColors`. This is what syntax
 * highlighting is made of, and it passes through Starbase untouched — shiki
 * consumes the same shape, so the diff viewer can be handed the theme's own
 * rules instead of an approximation built from the accent ramp.
 */
export const TokenColorRule = Schema.Struct({
  name: Schema.optional(Schema.String),
  /** A single scope, or several. Both spellings are common. */
  scope: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  settings: Schema.Struct({
    foreground: Schema.optional(Schema.String),
    background: Schema.optional(Schema.String),
    fontStyle: Schema.optional(Schema.String)
  })
})
export type TokenColorRule = Schema.Schema.Type<typeof TokenColorRule>

/**
 * A VS Code colour theme, as it exists on disk.
 *
 * The trailing index signature is load-bearing: without it Effect's `Struct`
 * strips every key it does not name, so saving an edited theme would quietly
 * delete `semanticTokenColors`, `$schema` and anything else the author wrote.
 * Starbase reads a handful of keys and preserves all of them.
 *
 * Note what is NOT here: `include`. VS Code's own built-ins are chains
 * (`dark_modern` → `dark_plus` → `dark_vs`), and a theme that still carries an
 * `include` is only a fragment. The vendoring script flattens those at build
 * time so nothing downstream has to resolve a graph at runtime.
 */
export const VsCodeTheme = Schema.Struct(
  {
    /** Display name, e.g. "Solarized Dark". */
    name: Schema.String,
    type: VsCodeThemeType,
    /** Workbench colours, keyed by VS Code's dotted names. Often partial. */
    colors: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    /** TextMate rules for syntax highlighting. Passed through to shiki. */
    tokenColors: Schema.optional(Schema.Array(TokenColorRule)),
    semanticHighlighting: Schema.optional(Schema.Boolean),
    semanticTokenColors: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)
export type VsCodeTheme = Schema.Schema.Type<typeof VsCodeTheme>

// ── The resolved token set ───────────────────────────────────────────────────

/**
 * The 16 ANSI colours plus the four chrome slots xterm.js needs.
 *
 * Separate from the flat `ThemeTokens` fields because these do NOT become CSS
 * custom properties — xterm paints to a canvas and takes a JS object. Folding
 * them into the same flat namespace would put twenty vars on `:root` that
 * nothing in CSS ever reads.
 */
export const TerminalPalette = Schema.Struct({
  background: HexColor,
  foreground: HexColor,
  cursor: HexColor,
  cursorAccent: HexColor,
  selectionBackground: CssColor,
  black: HexColor,
  red: HexColor,
  green: HexColor,
  yellow: HexColor,
  blue: HexColor,
  magenta: HexColor,
  cyan: HexColor,
  white: HexColor,
  brightBlack: HexColor,
  brightRed: HexColor,
  brightGreen: HexColor,
  brightYellow: HexColor,
  brightBlue: HexColor,
  brightMagenta: HexColor,
  brightCyan: HexColor,
  brightWhite: HexColor
})
export type TerminalPalette = Schema.Schema.Type<typeof TerminalPalette>

/**
 * Everything `:root` needs, resolved. One field per `--sb-*` custom property.
 *
 * The surface fields are ordered the way `globals.css` orders them — darkest to
 * lightest on a dark ground — because that ordering IS the contract: `canvas`
 * sits behind `panel` sits behind `editor`, and a mapper that inverts them
 * produces a theme where the sidebar floats above the content it contains.
 * On a light ground the ordering inverts with it; the *relationships* hold.
 */
export const ThemeTokens = Schema.Struct({
  /** Which ground this resolves to, so CSS and components can branch once. */
  kind: ThemeKind,

  // Surfaces
  /** The window's backmost plane — title bar, gaps between panels. */
  canvas: HexColor,
  /** Sidebars and cards. */
  panel: HexColor,
  /** Recessed wells — terminals, code blocks, popovers. */
  sunken: HexColor,
  /** The main content plane. VS Code's `editor.background`. */
  editor: HexColor,
  /** Raised chrome — tab strips, hovered rows, inline chips. */
  surface: HexColor,
  /** Hairlines between structural regions. Lower contrast than `line`. */
  hairline: HexColor,
  /** Default border/input colour. */
  line: HexColor,
  /** Emphasised borders and the "idle" status tone. */
  lineStrong: HexColor,

  // Text ramp (brightest → dimmest)
  /** Headings and emphasised text. */
  textBright: HexColor,
  /** Body prose. */
  textBody: HexColor,
  /** Default UI text. */
  text: HexColor,
  /** Secondary text — timestamps, captions. */
  muted: HexColor,
  /** Tertiary text — disabled, placeholder, line numbers. */
  dim: HexColor,

  // Accents
  blue: HexColor,
  green: HexColor,
  yellow: HexColor,
  red: HexColor,
  purple: HexColor,
  cyan: HexColor,
  orange: HexColor,

  // Effects — derived from `kind`, never read straight from a theme file.
  /** Modal scrim. Dark themes darken; light themes darken LESS, not lighten. */
  overlay: CssColor,
  /** Standard drop shadow colour. */
  shadow: CssColor,
  /** Heavier shadow for floating surfaces (dialogs, command palette). */
  shadowStrong: CssColor,
  /** Text selection wash. */
  selection: CssColor,
  /** Hover wash applied over an arbitrary surface. */
  hover: CssColor,

  // Diff washes — a background tint, so syntax tokens stay legible on top.
  diffAddBg: CssColor,
  diffDelBg: CssColor,
  diffAddFg: HexColor,
  diffDelFg: HexColor,

  // Scrollbars
  scrollbar: CssColor,
  scrollbarHover: CssColor,

  /** Link hover. Derived by lifting `blue` toward the text ramp. */
  linkHover: HexColor,

  /** xterm.js's palette. Not CSS — see `TerminalPalette`. */
  terminal: TerminalPalette
})
export type ThemeTokens = Schema.Schema.Type<typeof ThemeTokens>

/**
 * The `--sb-*` custom property each token writes to.
 *
 * Explicit rather than derived by camel→kebab, because the mapping is not
 * mechanical (`hairline` writes `--sb-border`, a name kept for compatibility
 * with the CSS that already ships) and because an explicit table is the thing
 * you read when a token mysteriously has no effect.
 *
 * `kind` and `terminal` are absent on purpose — neither is a CSS colour.
 */
export const CSS_VAR_BY_TOKEN: Readonly<Record<Exclude<keyof ThemeTokens, "kind" | "terminal">, string>> = {
  canvas: "--sb-canvas",
  panel: "--sb-panel",
  sunken: "--sb-sunken",
  editor: "--sb-editor",
  surface: "--sb-surface",
  hairline: "--sb-border",
  line: "--sb-line",
  lineStrong: "--sb-line-strong",
  textBright: "--sb-text-bright",
  textBody: "--sb-text-body",
  text: "--sb-text",
  muted: "--sb-muted",
  dim: "--sb-dim",
  blue: "--sb-blue",
  green: "--sb-green",
  yellow: "--sb-yellow",
  red: "--sb-red",
  purple: "--sb-purple",
  cyan: "--sb-cyan",
  orange: "--sb-orange",
  overlay: "--sb-overlay",
  shadow: "--sb-shadow",
  shadowStrong: "--sb-shadow-strong",
  selection: "--sb-selection",
  hover: "--sb-hover",
  diffAddBg: "--sb-diff-add-bg",
  diffDelBg: "--sb-diff-del-bg",
  diffAddFg: "--sb-diff-add-fg",
  diffDelFg: "--sb-diff-del-fg",
  scrollbar: "--sb-scrollbar",
  scrollbarHover: "--sb-scrollbar-hover",
  linkHover: "--sb-link-hover"
}

/** The id of the single managed theme style element. */
export const THEME_STYLE_ID = "starbase-theme"

/**
 * Emit the complete `:root` stylesheet for a resolved theme.
 *
 * Main and the renderer share this exact serializer so the pre-paint sheet and
 * React's first applied sheet are byte-identical. Keeping `color-scheme` here
 * matters too: it themes native controls, scrollbars and the caret.
 */
export const toCssText = (tokens: ThemeTokens): string => {
  const lines: Array<string> = []
  for (const [token, cssVar] of Object.entries(CSS_VAR_BY_TOKEN)) {
    lines.push(`  ${cssVar}: ${tokens[token as keyof typeof CSS_VAR_BY_TOKEN]};`)
  }
  lines.push(`  --sb-theme-kind: ${tokens.kind};`)
  lines.push(`  color-scheme: ${tokens.kind === "light" ? "light" : "dark"};`)
  return `:root {\n${lines.join("\n")}\n}\n`
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** Where a theme came from. Built-ins are read-only; user themes are files. */
export const ThemeSource = Schema.Literal("builtin", "user")
export type ThemeSource = Schema.Schema.Type<typeof ThemeSource>

/**
 * A theme as the picker sees it: enough to render a swatch and apply it, with
 * no second round trip.
 *
 * `tokens` is included rather than fetched per selection because the Themes
 * settings grid previews every theme at once — nine-plus round trips to paint
 * one screen would make the grid pop in raggedly, and the payload is a few
 * hundred bytes each.
 */
export const ThemeSummary = Schema.Struct({
  /** Stable id — a preset's slug, or a user file's basename without `.json`. */
  id: Schema.String,
  /** Display name from the theme's own `name` field. */
  name: Schema.String,
  kind: ThemeKind,
  source: ThemeSource,
  /** Absolute path, for user themes only (built-ins are bundled). */
  path: Schema.optional(Schema.String),
  tokens: ThemeTokens
})
export type ThemeSummary = Schema.Schema.Type<typeof ThemeSummary>

/** A user theme file that failed to decode, named so the UI can say which. */
export const ThemeLoadFailure = Schema.Struct({
  path: Schema.String,
  message: Schema.String
})
export type ThemeLoadFailure = Schema.Schema.Type<typeof ThemeLoadFailure>

/**
 * Everything installed, plus what could not be read.
 *
 * `skipped` travels WITH the list rather than being thrown, because one
 * malformed file in `~/starbase/themes` must not take out the picker. The user
 * needs to keep switching themes AND to be told which file is broken; an error
 * channel can only do the second.
 */
export const ThemeCatalog = Schema.Struct({
  themes: Schema.Array(ThemeSummary),
  skipped: Schema.Array(ThemeLoadFailure)
})
export type ThemeCatalog = Schema.Schema.Type<typeof ThemeCatalog>

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * The persisted theme choice, stored at `WorkspaceConfig.theme`.
 *
 * `colorCustomizations` mirrors VS Code's `workbench.colorCustomizations`: a
 * thin override layer applied on top of the chosen theme, keyed by the same
 * dotted names. It exists so "I love Monokai but its sidebar is too dark" does
 * not force a fork of the whole theme — the same reason VS Code has it.
 * Overrides are keyed by VS Code name, not by `--sb-*` token, so they stay
 * portable back to VS Code.
 */
export const ThemeConfig = Schema.Struct({
  /** Id of the active theme — a preset slug or a user file's stem. */
  activeId: Schema.String,
  /** Per-key overrides applied over the active theme's `colors`. */
  colorCustomizations: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  )
})
export type ThemeConfig = Schema.Schema.Type<typeof ThemeConfig>

/**
 * The theme a fresh install starts on, and the one every failure falls back to.
 *
 * One Dark Pro rather than a VS Code built-in because it is the palette the
 * whole design system was drawn against — `globals.css`'s fallback block, the
 * status accents in `tokens.ts` and every Storybook snapshot assume it. A
 * fallback that changed the app's appearance would make "the theme failed to
 * load" indistinguishable from "the theme loaded".
 */
export const DEFAULT_THEME_ID = "one-dark-pro"

/**
 * Filesystem-safe id from a display name: "Solarized Dark" → "solarized-dark".
 *
 * Used when duplicating, so the copy's id matches the filename it lands at and
 * `~/starbase/themes/solarized-dark-copy.json` is guessable from the picker.
 */
export const themeIdFromName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "theme"
