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
/**
 * Kept as a re-export for the theme package's public API. The implementation
 * lives in core so Electron main and the React provider cannot drift.
 */
export { THEME_STYLE_ID, toCssText } from "@starbase/core"
