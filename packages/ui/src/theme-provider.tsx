/**
 * Applies a theme to the document, and hands the resolved tokens to the few
 * components that need them as VALUES rather than as CSS.
 *
 * ## One style element, replaced wholesale
 *
 * Themes are applied by rewriting the text of a single managed `<style>`, not by
 * calling `setProperty` per token. Three reasons, in order of how badly each
 * bites:
 *
 * 1. **Nothing goes stale.** `setProperty` only ever ADDS. Switching from a
 *    theme that sets a var to one that does not leaves the old value in place
 *    forever, so the app ends up wearing a colour from a theme the operator
 *    stopped using two switches ago — and no amount of switching clears it.
 * 2. **It is atomic.** Thirty-odd property writes repaint progressively, and on
 *    a slow frame the app is visibly half Monokai and half Solarized.
 * 3. **Main can produce the identical string** before React exists, which is
 *    what makes the first paint flash-free. Same function, same output; see
 *    `main/boot-theme.ts`.
 *
 * ## Why the tokens are also in context
 *
 * Almost everything reads colours through Tailwind utilities and needs nothing
 * from here. Two things cannot: xterm paints to a canvas and takes a JS object,
 * and shiki needs the theme's TextMate rules. Those read `useThemeTokens()`.
 * Anything else reaching for this hook is a sign a component is hardcoding a
 * colour that should be a utility class.
 */
import * as React from "react"
import type { ThemeCatalog, ThemeTokens, VsCodeTheme } from "@starbase/core"
import { DEFAULT_THEME_ID, THEME_STYLE_ID, toCssText } from "@starbase/core"

/** Backward-compatible name for callers that render theme CSS directly. */
export const themeCssText = toCssText

interface ThemeContextValue {
  readonly tokens: ThemeTokens
  readonly activeId: string
  /** Everything installed, plus files that could not be decoded. */
  readonly catalog: ThemeCatalog | undefined
  /** The active theme's raw JSON, for shiki. Null until it loads. */
  readonly theme: VsCodeTheme | null
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

/**
 * The active theme's resolved tokens.
 *
 * Throws outside a provider rather than returning a One Dark default, because a
 * silent default is how a component ends up permanently dark on a light theme
 * with nothing to indicate why.
 */
export const useThemeTokens = (): ThemeTokens => {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error("useThemeTokens must be used inside <ThemeProvider>")
  return ctx.tokens
}

/** The active theme's id and full catalog — the settings picker's data source. */
export const useThemeCatalog = (): {
  activeId: string
  catalog: ThemeCatalog | undefined
} => {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error("useThemeCatalog must be used inside <ThemeProvider>")
  return { activeId: ctx.activeId, catalog: ctx.catalog }
}

/**
 * The active theme's raw JSON, for syntax highlighting.
 *
 * `ThemeTokens` deliberately does not carry `tokenColors` — it is up to 275
 * TextMate rules, and the settings grid ships tokens for nine themes at once.
 * The diff viewer is the one consumer that needs them, so it fetches the raw
 * theme for the ACTIVE id only.
 *
 * Returns null, rather than throwing, outside a provider or before the theme
 * loads: highlighting already had to handle "no theme yet" for the async
 * grammar window, and rendering a diff unhighlighted for a frame is a much
 * better outcome than not rendering it.
 */
export const useThemeSyntax = (): VsCodeTheme | null =>
  React.useContext(ThemeContext)?.theme ?? null

/**
 * `useThemeTokens`, but null outside a provider instead of throwing.
 *
 * For the few places that must render with or without a theme: Storybook
 * stories, the diff test suite, and anything mounted before `ThemeProvider`.
 * Prefer `useThemeTokens` everywhere else — a component that silently falls
 * back to nothing is exactly the failure this hook's strict sibling exists to
 * make loud.
 */
export const useOptionalThemeTokens = (): ThemeTokens | null =>
  React.useContext(ThemeContext)?.tokens ?? null

export interface ThemeProviderProps {
  /** The resolved tokens to apply. */
  tokens: ThemeTokens
  /**
   * Whether `tokens` are resolved and may replace the pre-paint stylesheet.
   * False during Electron's config/catalog handoff; defaults true elsewhere.
   */
  applyToDocument?: boolean
  /** Id of the active theme, so the picker can mark it. */
  activeId?: string
  /** Everything installed. Absent in Storybook and tests. */
  catalog?: ThemeCatalog
  /** The active theme's raw JSON, for shiki. Absent until it loads. */
  theme?: VsCodeTheme | null
  children: React.ReactNode
}

export function ThemeProvider({
  tokens,
  applyToDocument = true,
  activeId = DEFAULT_THEME_ID,
  catalog,
  theme = null,
  children
}: ThemeProviderProps) {
  /**
   * `useLayoutEffect`, not `useEffect`.
   *
   * The tokens change at two moments that matter: mount, and a theme switch.
   * With `useEffect` the browser is free to paint between React committing the
   * new tree and the stylesheet being swapped, so a switch flickers through the
   * OLD theme's colours with the NEW theme's layout. Layout effects run before
   * that paint.
   */
  React.useLayoutEffect(() => {
    // Electron injected the active theme before React mounted. While its async
    // config/catalog queries are pending, `tokens` is only a One Dark context
    // fallback and must not clobber that correct boot stylesheet.
    if (!applyToDocument) return

    const doc = globalThis.document
    if (!doc) return

    let el = doc.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
    if (!el) {
      el = doc.createElement("style")
      el.id = THEME_STYLE_ID
      // Appended to <head> LAST so it wins over the fallback block in
      // globals.css on document order at equal specificity — no `!important`,
      // which would stop the settings editor's live preview overriding it.
      doc.head.appendChild(el)
    }
    el.textContent = toCssText(tokens)

    // A custom property cannot be used in a selector, so the ground is mirrored
    // onto a data attribute for the handful of rules that must BRANCH on it
    // rather than read a value.
    doc.documentElement.dataset.themeKind = tokens.kind
  }, [tokens, applyToDocument])

  const value = React.useMemo(
    (): ThemeContextValue => ({ tokens, activeId, catalog, theme }),
    [tokens, activeId, catalog, theme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
