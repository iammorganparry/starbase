/**
 * Electron main entry — standard electron-vite lifecycle. On ready it forces the
 * Effect runtime to build (which forks the RPC server and registers the IPC
 * listener) and then opens the window. The renderer talks to the backend purely
 * through the RPC transport in `./rpc.ts`.
 */
import { join } from "node:path"
import { app, BrowserWindow } from "electron"
import { Effect } from "effect"
import { runtime } from "./runtime.js"

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  void runtime.dispose()
})
