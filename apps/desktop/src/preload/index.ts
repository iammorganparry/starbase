/**
 * Preload bridge. Exposes a minimal, safe surface on `window.starbase` that only
 * shuttles opaque RPC frames between the renderer's `RpcClient` and the main
 * process's `RpcServer`. No business logic lives here — see `src/main/rpc.ts`.
 */
import { contextBridge, ipcRenderer } from "electron"

const RPC_CHANNEL = "starbase/rpc"
const AUTH_COMPLETE_CHANNEL = "starbase/auth-complete"

interface AuthCompletePayload {
  readonly ok: boolean
  readonly error: string | null
}

contextBridge.exposeInMainWorld("starbase", {
  /** Ship one client→server RPC frame to main. */
  send: (data: unknown) => ipcRenderer.send(RPC_CHANNEL, data),
  /** Subscribe to server→client RPC frames; returns an unsubscribe fn. */
  on: (cb: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
    ipcRenderer.on(RPC_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RPC_CHANNEL, listener)
  },
  /** Open an http(s) URL in the user's default browser (not an Electron window). */
  openExternal: (url: string) => ipcRenderer.invoke("starbase/open-external", url),
  /**
   * Subscribe to `starbase://` sign-in completions (the deep-link callback landed
   * and the token was stored). Returns an unsubscribe fn. The renderer re-checks
   * the session on `ok`.
   */
  onAuthComplete: (cb: (payload: AuthCompletePayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AuthCompletePayload) =>
      cb(payload)
    ipcRenderer.on(AUTH_COMPLETE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(AUTH_COMPLETE_CHANNEL, listener)
  }
})
