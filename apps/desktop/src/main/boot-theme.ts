/**
 * Resolves the operator's theme before the window exists, so the very first
 * frame is already the right colour.
 *
 * ## Why this is in main at all
 *
 * The obvious place to apply a theme is the renderer: read the config over RPC,
 * set the CSS vars, done. That is what `ThemeProvider` does for every SUBSEQUENT
 * change, and it is correct there. It cannot handle the first paint, because by
 * the time the renderer has mounted, asked main for the config and got an
 * answer, the browser has already painted at least one frame using the fallback
 * block in `globals.css` — which is One Dark. On a light theme that is a full
 * white-on-dark flash, and it happens on every single launch.
 *
 * There are two separate flashes to kill and they need different fixes:
 *
 *   1. **The window's own background**, painted by Electron before any HTML
 *      exists. Fixed by handing `BrowserWindow` the resolved `canvas` colour
 *      instead of the hardcoded `#16181d` it used when the app was dark-only.
 *   2. **The document's first paint**, before React runs. Fixed by the preload
 *      pulling the theme's CSS SYNCHRONOUSLY (`ipcRenderer.sendSync`) and
 *      `main.tsx` injecting it before `createRoot`.
 *
 * Synchronous IPC is normally worth avoiding — it blocks the renderer process.
 * Here that is precisely the point, and the cost is one already-computed string
 * copied across a process boundary once per launch.
 */
import { ThemeService, ConfigService } from "@starbase/cli-adapters"
import { toCssText, toTokens } from "@starbase/themes"
import type { ThemeTokens } from "@starbase/core"
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.js"

/** The channel the preload reads synchronously. Must match `preload/index.ts`. */
export const BOOT_THEME_CHANNEL = "starbase/boot-theme"

/**
 * The resolved boot theme, computed once during `whenReady`.
 *
 * Cached in a module variable rather than recomputed per request because the
 * request arrives on the SYNCHRONOUS IPC path — doing filesystem reads there
 * would block the renderer's startup on disk latency, which is the opposite of
 * what this module is for.
 */
let bootTokens: ThemeTokens | null = null

/**
 * Read the config, resolve the active theme, and fold it to tokens.
 *
 * Never fails. Every branch — no config, a config naming a deleted theme, a
 * malformed theme file — resolves to One Dark Pro, because launching into an
 * unstyled window is worse than launching into the wrong theme. `ThemeService.resolve`
 * owns that fallback; this just refuses to let a config read failure escape.
 */
export const resolveBootTheme = async (): Promise<ThemeTokens> => {
  const tokens = await runtime.runPromise(
    Effect.gen(function* () {
      const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
      const { theme } = yield* ThemeService.resolve(config?.theme?.activeId)
      return toTokens(theme, config?.theme?.colorCustomizations as Record<string, string> | undefined)
    })
  )
  bootTokens = tokens
  return tokens
}

/**
 * Serve the boot stylesheet on a synchronous channel.
 *
 * Registered once, at startup. If a renderer somehow asks before
 * `resolveBootTheme` has run, it gets an empty string rather than a stall — the
 * fallback block in `globals.css` then applies, which is exactly the pre-theming
 * behaviour and strictly better than a hung window.
 */
export const registerBootThemeChannel = (): void => {
  ipcMain.on(BOOT_THEME_CHANNEL, (event) => {
    event.returnValue = bootTokens ? toCssText(bootTokens) : ""
  })
}

/**
 * The colour Electron paints the window with before the first frame of HTML.
 *
 * `canvas` and not `editor`: canvas is the app's backmost plane — the title bar
 * and the gaps between panels — so it is what the window's own chrome should
 * match while the document loads.
 */
export const bootBackgroundColor = (tokens: ThemeTokens): string => tokens.canvas
