/**
 * Electron main entry — standard electron-vite lifecycle. On ready it forces the
 * Effect runtime to build (which forks the RPC server and registers the IPC
 * listener) and then opens the window. The renderer talks to the backend purely
 * through the RPC transport in `./rpc.ts`.
 *
 * It also owns the `starbase://` deep-link sign-in bridge: a single-instance lock
 * keeps auth callbacks landing in the running app, and an inbound callback stores
 * the session token (OS keychain, via `SecretStore`) before telling the renderer
 * to re-check auth.
 */
import { join } from "node:path"
import {
  DiscoveryService,
  killAllChildren,
  ModelsService,
  SecretStore,
  TerminalService
} from "@starbase/cli-adapters"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { Effect } from "effect"
import type { AuthCallback } from "./deep-link.js"
import {
  AUTH_COMPLETE_CHANNEL,
  findDeepLinkInArgv,
  parseAuthCallback,
  registerProtocolClient
} from "./deep-link.js"
import { runtime } from "./runtime.js"
import { initAutoUpdater } from "./updater.js"

/** The single renderer window (kept so deep-link callbacks can reach + focus it). */
let mainWindow: BrowserWindow | null = null

/**
 * Warm `ModelsService`'s cache before anything asks for it.
 *
 * Discovering models is the slowest read the app makes: it probes for each CLI
 * and then asks the Codex CLI for its catalogue over its app-server protocol.
 * Doing that lazily means the first session's model chip fills in a beat late.
 * Doing it here means it happens while the window paints and the user signs in —
 * by the time anyone opens a session, `Models.catalog` is a cache hit.
 *
 * Deliberately fire-and-forget: it must never delay the window or fail the boot.
 * A cold cache is only ever a slower chip, never a broken app, so nothing waits
 * on this and every error is swallowed.
 */
const prefetchModels = Effect.gen(function* () {
  const clis = yield* DiscoveryService.list()
  yield* ModelsService.catalog(clis)
}).pipe(Effect.ignore)

// Only one instance may run: a second launch (e.g. the OS handing us a
// `starbase://` deep link) must forward its argv into the primary instance
// rather than spawn a rival window. If we didn't get the lock, we're that second
// launch — quit immediately and let `second-instance` do the delivery.
const gotPrimaryLock = app.requestSingleInstanceLock()
if (!gotPrimaryLock) {
  app.quit()
} else {
  registerProtocolClient()

  /** Open an http(s) URL (e.g. a PR link) in the user's default browser. */
  ipcMain.handle("starbase/open-external", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  /**
   * Deliver a parsed auth callback: persist the token (keychain) then notify the
   * renderer. A token-less callback (or a storage failure) reports `ok: false` so
   * the LoginScreen can show its error state.
   */
  const deliverAuthCallback = (cb: AuthCallback): void => {
    const notify = (ok: boolean, error: string | null = null) =>
      mainWindow?.webContents.send(AUTH_COMPLETE_CHANNEL, { ok, error })
    if (!cb.token) {
      notify(false, cb.error)
      return
    }
    const token = cb.token
    void runtime
      .runPromise(Effect.flatMap(SecretStore, (store) => store.set(token)))
      .then(() => notify(true))
      .catch(() => notify(false, "storage"))
  }

  const focusMainWindow = (): void => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  // macOS delivers the deep link as an event, even while running.
  app.on("open-url", (event, url) => {
    event.preventDefault()
    const cb = parseAuthCallback(url)
    if (cb) deliverAuthCallback(cb)
  })

  // Windows/Linux deliver it as argv on the second launch.
  app.on("second-instance", (_event, argv) => {
    const link = findDeepLinkInArgv(argv)
    if (link) {
      const cb = parseAuthCallback(link)
      if (cb) deliverAuthCallback(cb)
    }
    focusMainWindow()
  })

  const createWindow = () => {
    const window = new BrowserWindow({
      width: 1320,
      height: 860,
      show: false,
      backgroundColor: "#16181d",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.mjs"),
        contextIsolation: true,
        sandbox: false
      }
    })
    mainWindow = window

    window.on("ready-to-show", () => window.show())
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null
    })

    // Cold-start deep link (Windows/Linux): the URL is in our own argv. Deliver it
    // once the renderer has loaded so the auth-complete event isn't dropped.
    const coldLink = findDeepLinkInArgv(process.argv)
    if (coldLink) {
      window.webContents.once("did-finish-load", () => {
        const cb = parseAuthCallback(coldLink)
        if (cb) deliverAuthCallback(cb)
      })
    }

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(import.meta.dirname, "../renderer/index.html"))
    }
  }

  app.whenReady().then(async () => {
    // Force the layer to build so the RPC server + `ipcMain` listener are live
    // before the renderer can send its first frame.
    await runtime.runPromise(Effect.void)
    // Not awaited — the catalogue warms in the background while the window opens.
    void runtime.runPromise(prefetchModels)
    createWindow()

    // Self-update only makes sense in a packaged build (dev has no update feed).
    if (app.isPackaged) initAutoUpdater()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", () => {
    // Nothing we spawned is reaped when the main process exits — POSIX reparents
    // orphans to init and they live forever. Two families of child, killed the
    // same way for the same reason:
    //
    //  - PTYs, which live in their own session (TerminalService.killAll);
    //  - harness subprocesses — `opencode serve`, `codex app-server` — which each
    //    spawn site cleans up on its own happy path, but NOT when the app quits
    //    mid-flight. That gap leaked one `opencode serve` per e2e test, since the
    //    suite tears down Electron once per test while the model catalogue is
    //    still being fetched.
    //
    // Synchronous and first: `runtime.dispose()` below may never get the chance to
    // run to completion, and an orphaned server outlives the app either way.
    killAllChildren()
    void runtime
      .runPromise(Effect.flatMap(TerminalService, (t) => t.killAll))
      .catch(() => {})
      .finally(() => void runtime.dispose())
  })
}
