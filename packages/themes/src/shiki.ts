/**
 * Hands the active theme's own syntax rules to shiki.
 *
 * Before theming, `diff/highlight.ts` pinned shiki to the string
 * `"one-dark-pro"` and loaded it from shiki's bundled set. That has to go: a
 * diff highlighted in One Dark Pro inside a Solarized Light panel is not a
 * small mismatch, it is unreadable — dark-theme syntax colours are chosen
 * against a near-black background and most of them vanish on cream.
 *
 * shiki's `ThemeRegistrationRaw` is, conveniently, the VS Code theme format. So
 * there is no conversion here worth the name; the work is in the two fixups
 * below, both of which exist because shiki is stricter than VS Code about
 * things real themes get away with.
 */
import type { ThemeTokens, VsCodeTheme } from "@starbase/core"

/** The subset of shiki's theme shape we produce. Structural, so no dependency. */
export interface ShikiThemeLike {
  name: string
  type: "dark" | "light"
  colors: Record<string, string>
  tokenColors: ReadonlyArray<{
    scope?: string | ReadonlyArray<string>
    settings: { foreground?: string; background?: string; fontStyle?: string }
  }>
  bg: string
  fg: string
}

/**
 * Build the object shiki wants from a theme plus its already-folded tokens.
 *
 * Two fixups:
 *
 * 1. **`bg`/`fg` are mandatory.** shiki reads them to colour the wrapper
 *    element, and derives them from `colors["editor.background"]` when it can
 *    — which High Contrast Dark has but plenty of user themes will not. Taking
 *    them from `ThemeTokens` instead means they are always present and always
 *    agree with the panel the code is rendered on.
 *
 * 2. **`type` is narrowed to dark|light.** shiki has no high-contrast case, and
 *    passing `"hcDark"` makes it fall back to its own default theme silently —
 *    which looks exactly like our highlighting not being applied at all.
 */
export const toShikiTheme = (theme: VsCodeTheme, tokens: ThemeTokens): ShikiThemeLike => ({
  name: theme.name,
  type: tokens.kind === "light" ? "light" : "dark",
  colors: { ...(theme.colors ?? {}) },
  tokenColors: theme.tokenColors ?? [],
  // The diff body paints its own add/remove wash, so shiki's background must be
  // the surface underneath rather than the theme's editor colour.
  bg: tokens.sunken,
  fg: tokens.textBody
})
