/// <reference types="vite/client" />

// The app version, inlined at build time by electron-vite (see
// electron.vite.config.ts). Available in main, preload and renderer.
declare const __APP_VERSION__: string

// The narrow, safe surface the preload bridge exposes on `window`. It only
// shuttles opaque RPC frames — no business logic lives here. See
// `src/preload/index.ts` and `src/renderer/rpc-client.ts`.
interface StarbaseBridge {
  /** Send one client→server RPC frame to the main process. */
  readonly send: (data: unknown) => void
  /** Subscribe to server→client RPC frames. Returns an unsubscribe fn. */
  readonly on: (cb: (data: unknown) => void) => () => void
}

interface Window {
  readonly starbase: StarbaseBridge
}

// `import "@starbase/ui/globals.css"` resolves to a real stylesheet that Vite
// loads; tsc just needs to know the side-effect import is a module.
declare module "*.css"
