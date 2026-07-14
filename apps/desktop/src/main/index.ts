/**
 * Electron main entry — standard electron-vite lifecycle. On ready it forces the
 * Effect runtime to build (which forks the RPC server and registers the IPC
 * listener) and then opens the window. The renderer talks to the backend purely
 * through the RPC transport in `./rpc.ts`.
 */
import { join } from "node:path"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { TerminalService } from "@starbase/cli-adapters"
import { Effect } from "effect"
import { runtime } from "./runtime.js"
import { initAutoUpdater } from "./updater.js"

/** Open an http(s) URL (e.g. a PR link) in the user's default browser. */
ipcMain.handle("starbase/open-external", (_event, url: unknown) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url)
  return undefined
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

  window.on("ready-to-show", () => window.show())

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
  // PTY child processes live in their own session and are NOT reaped when the
  // main process exits, so kill them explicitly (best-effort) before teardown.
  void runtime
    .runPromise(Effect.flatMap(TerminalService, (t) => t.killAll))
    .catch(() => {})
    .finally(() => void runtime.dispose())
})
