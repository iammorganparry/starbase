/**
 * BrowserPreviewService — the main-process owner of the embedded browser preview.
 *
 * The preview is a native `WebContentsView` (Electron's recommended embed) layered
 * over the renderer at the pane's on-screen rect. It lives in the main process
 * because `WebContentsView` is main-only, and it renders OUTSIDE the renderer's
 * DOM and CSP — which is exactly why it can load an arbitrary `http://localhost`
 * dev server that the renderer's `default-src 'self'` policy would otherwise block.
 *
 * Security posture: the view runs with `sandbox: true` + `contextIsolation: true`
 * and NO preload, so the previewed page has no bridge to the app. Only http/https
 * URLs are accepted; `window.open`/new-window requests are denied; and
 * in-page navigations to non-http(s) schemes are blocked. There is exactly one
 * window (see rpc.ts), so the view attaches to `BrowserWindow.getAllWindows()[0]`.
 */
import type { BrowserBounds } from "@starbase/core"
import { BrowserPreviewError } from "@starbase/core"
import { BrowserWindow, WebContentsView } from "electron"
import { Context, Effect, Layer } from "effect"

export interface BrowserPreviewServiceShape {
  /** Show the view and load `url` at `bounds`. Rejects non-http(s) URLs. */
  readonly open: (url: string, bounds: BrowserBounds) => Effect.Effect<void, BrowserPreviewError>
  /** Track the pane's rect (layout/scroll). No-op when closed. */
  readonly setBounds: (bounds: BrowserBounds) => Effect.Effect<void>
  /** Navigate the open view. Rejects non-http(s) URLs. */
  readonly navigate: (url: string) => Effect.Effect<void, BrowserPreviewError>
  /** Reload the current page. No-op when closed. */
  readonly reload: () => Effect.Effect<void>
  /** Hide + destroy the view. Idempotent. */
  readonly close: () => Effect.Effect<void>
}

export class BrowserPreviewService extends Context.Tag("@starbase/BrowserPreviewService")<
  BrowserPreviewService,
  BrowserPreviewServiceShape
>() {}

/** Only http/https load into the preview — it's a localhost dev-server viewer. Exported for tests. */
export const isHttpUrl = (url: string): boolean => {
  try {
    const p = new URL(url).protocol
    return p === "http:" || p === "https:"
  } catch {
    return false
  }
}

const rejectBadUrl = (url: string) =>
  Effect.fail(new BrowserPreviewError({ message: `Only http(s) URLs can be previewed: ${url}` }))

/** Integer device-independent pixels — `setBounds` requires ints. Exported for tests. */
export const toRect = (b: BrowserBounds) => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})

export const BrowserPreviewServiceLive = Layer.sync(BrowserPreviewService, () => {
  // The single live preview view (or null when closed). Captured in this closure
  // so the service value is stateful without a class.
  let view: WebContentsView | null = null

  const mainWindow = (): BrowserWindow | null => BrowserWindow.getAllWindows()[0] ?? null

  /** Load a URL into the view, swallowing load failures (e.g. dev server not up
   *  yet → ERR_CONNECTION_REFUSED) so the RPC still succeeds and the view shows
   *  the browser's own error page. */
  const load = (url: string) => {
    view?.webContents.loadURL(url).catch(() => {})
  }

  const ensureView = (): WebContentsView | null => {
    const win = mainWindow()
    if (!win) return null
    if (!view) {
      view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      // No popups; keep navigation inside the view and on http(s).
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
      view.webContents.on("will-navigate", (event, url) => {
        if (!isHttpUrl(url)) event.preventDefault()
      })
      win.contentView.addChildView(view)
    }
    return view
  }

  const destroy = () => {
    if (!view) return
    const win = mainWindow()
    win?.contentView.removeChildView(view)
    // `close()` tears down the WebContents; guard in case it's already gone.
    try {
      view.webContents.close()
    } catch {
      /* already destroyed */
    }
    view = null
  }

  return {
    open: (url, bounds) =>
      isHttpUrl(url)
        ? Effect.sync(() => {
            const v = ensureView()
            if (!v) return
            v.setBounds(toRect(bounds))
            load(url)
          })
        : rejectBadUrl(url),
    setBounds: (bounds) => Effect.sync(() => view?.setBounds(toRect(bounds))),
    navigate: (url) =>
      isHttpUrl(url) ? Effect.sync(() => load(url)) : rejectBadUrl(url),
    reload: () => Effect.sync(() => view?.webContents.reload()),
    close: () => Effect.sync(destroy)
  }
})
