/**
 * `ThemeTokens` → the stylesheet text that overrides `:root`.
 *
 * Deliberately a plain string rather than a set of `setProperty` calls. The
 * renderer swaps themes by replacing the text content of ONE managed `<style>`
 * element, which means:
 *
 * - Switching themes is atomic. Thirty-odd `setProperty` calls repaint
 *   progressively, and on a slow frame the app is briefly half Monokai.
 * - Nothing goes stale. `setProperty` leaves any var the new theme does not
 *   mention exactly as the old theme left it, so switching from a theme that
 *   sets a var to one that does not silently keeps the old value forever.
 * - The main process can produce the same string at boot, before any React
 *   exists, which is what makes the first paint flash-free.
 *
 * The selector is `:root` and the sheet is appended last, so it beats the
 * fallback block in `globals.css` on document order at equal specificity —
 * without `!important`, which would make the settings editor's live preview
 * unable to override it in turn.
 */
import type { ThemeTokens } from "@starbase/core"
import { CSS_VAR_BY_TOKEN } from "@starbase/core"

/** The id of the single managed style element. Shared by main and renderer. */
export const THEME_STYLE_ID = "starbase-theme"

/**
 * Emit `:root { --sb-*: …; }` for every colour token.
 *
 * `kind` is emitted too, as `--sb-theme-kind`, so CSS can branch on the ground
 * without JS — `@media` cannot ask "is the theme light", but
 * `:root[data-theme-kind="light"]` can, and the var is there for the cases that
 * need a value rather than a selector.
 */
export const toCssText = (tokens: ThemeTokens): string => {
  const lines: string[] = []
  for (const [token, cssVar] of Object.entries(CSS_VAR_BY_TOKEN)) {
    const value = tokens[token as keyof typeof CSS_VAR_BY_TOKEN]
    lines.push(`  ${cssVar}: ${value};`)
  }
  lines.push(`  --sb-theme-kind: ${tokens.kind};`)
  // `color-scheme` makes the browser theme its own chrome — form controls,
  // native scrollbars, the caret. Without it a light theme still gets a dark
  // date picker and a dark caret in every input.
  lines.push(`  color-scheme: ${tokens.kind === "light" ? "light" : "dark"};`)
  return `:root {\n${lines.join("\n")}\n}\n`
}

/**
 * The `<style>` element itself, for the main process to inline into the HTML
 * document before the renderer's first paint.
 */
export const toStyleTag = (tokens: ThemeTokens): string =>
  `<style id="${THEME_STYLE_ID}">${toCssText(tokens)}</style>`
