/**
 * Preload bridge. Exposes a minimal, safe surface on `window.starbase` that only
 * shuttles opaque RPC frames between the renderer's `RpcClient` and the main
 * process's `RpcServer`. No business logic lives here — see `src/main/rpc.ts`.
 */
import { contextBridge, ipcRenderer } from "electron"

const RPC_CHANNEL = "starbase/rpc"

contextBridge.exposeInMainWorld("starbase", {
  /** Ship one client→server RPC frame to main. */
  send: (data: unknown) => ipcRenderer.send(RPC_CHANNEL, data),
  /** Subscribe to server→client RPC frames; returns an unsubscribe fn. */
  on: (cb: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
    ipcRenderer.on(RPC_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RPC_CHANNEL, listener)
  }
})
