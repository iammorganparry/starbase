/**
 * Keeps the renderer's copy of the active theme in step with main.
 *
 * Three things can change which colours the app shows, and this hook is where
 * all three converge:
 *
 *   - the operator picks a theme in Settings (a `Theme.setActive` write),
 *   - they edit a colour in the theme editor (a `Theme.save` write),
 *   - they edit `~/starbase/themes/<id>.json` in their OWN editor, with
 *     Starbase not involved at all (the `Theme.watch` stream).
 *
 * The third is the reason this subscribes rather than just fetching. It is also
 * the one people will not believe works until they see it, so it is worth the
 * stream: save in your editor, and the app repaints before you have switched
 * windows.
 *
 * The FIRST paint is not handled here and cannot be — by the time React has
 * mounted and asked main anything, the browser has already painted. That is
 * `main/boot-theme.ts` plus the preload's synchronous fetch; this hook takes
 * over from the identical stylesheet, so the handover is invisible.
 */
import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ThemeCatalog, ThemeTokens, VsCodeTheme, WorkspaceConfig } from "@starbase/core"
import { DEFAULT_THEME_ID } from "@starbase/core"
import { BUILTIN_THEMES, toTokens } from "@starbase/themes"
import { rpc } from "./rpc-client.js"

export const themeCatalogKey = ["themes"] as const

/**
 * The tokens to render with, resolved from the catalog and the config.
 *
 * Falls back to the bundled One Dark Pro whenever the active id names nothing —
 * the theme was deleted, its file went malformed, the catalog has not loaded
 * yet. `ThemeService.resolve` makes the same choice on the main side; both
 * exist because both sides can be asked before the other has answered.
 */
const resolveTokens = (
  catalog: ThemeCatalog | undefined,
  config: WorkspaceConfig | null | undefined
): { tokens: ThemeTokens; activeId: string } => {
  const activeId = config?.theme?.activeId ?? DEFAULT_THEME_ID
  const found = catalog?.themes.find((t) => t.id === activeId)
  if (found) return { tokens: found.tokens, activeId }

  const fallback = BUILTIN_THEMES.find((b) => b.id === DEFAULT_THEME_ID)!
  return { tokens: toTokens(fallback.theme), activeId: catalog ? DEFAULT_THEME_ID : activeId }
}

export interface ThemeState {
  readonly tokens: ThemeTokens
  readonly activeId: string
  readonly catalog: ThemeCatalog | undefined
  /** The active theme's raw JSON, for shiki. Null until it loads. */
  readonly theme: VsCodeTheme | null
}

export function useTheme(config: WorkspaceConfig | null | undefined): ThemeState {
  const queryClient = useQueryClient()

  const { data: catalog } = useQuery({
    queryKey: themeCatalogKey,
    queryFn: () => rpc.themeList(),
    // The catalog only changes through writes this app makes or through the
    // watch stream below, both of which seed the cache directly. Refetching on
    // focus would re-read nine themes off disk every time the window is
    // clicked, for a result that is already known to be current.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  })

  useEffect(
    () =>
      rpc.themeWatch((next) => {
        // Seed rather than invalidate: the stream already carries the whole
        // catalog, so invalidating would round-trip for a payload we hold.
        queryClient.setQueryData(themeCatalogKey, next)
      }),
    [queryClient]
  )

  const { activeId, tokens } = useMemo(() => resolveTokens(catalog, config), [catalog, config])

  /**
   * The active theme's raw JSON, fetched separately from the catalog.
   *
   * Separately because `tokenColors` is up to 275 TextMate rules and the
   * catalog carries nine themes — shipping the rules for all of them to paint a
   * swatch grid would be most of a megabyte for something only the diff viewer
   * reads. So the catalog carries resolved tokens (small, needed by everything)
   * and this fetches the rules for the ONE theme that is actually active.
   */
  const { data: theme } = useQuery({
    queryKey: ["theme-source", activeId],
    queryFn: () => rpc.themeGet(activeId),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  })

  // A theme edited on disk changes its rules too, so the fetched source has to
  // be dropped when the catalog moves — otherwise the diff keeps highlighting
  // from the pre-edit copy until the app restarts.
  useEffect(() => {
    if (catalog) void queryClient.invalidateQueries({ queryKey: ["theme-source"] })
  }, [catalog, queryClient])

  return useMemo(
    () => ({ tokens, activeId, catalog, theme: theme ?? null }),
    [tokens, activeId, catalog, theme]
  )
}
