import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// The app version — single source of truth is this package.json (bumped in
// lockstep by `changeset version`). Inlined into every process as the global
// `__APP_VERSION__` so main, preload and renderer all report the same version
// without reading package.json at runtime.
const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8")
)
const define = { __APP_VERSION__: JSON.stringify(version) }

// The `@starbase/*` workspace packages ship raw TypeScript source (their
// `exports` point at `src/*.ts`). Node can't run those directly in the main
// process, so we must NOT externalize them — Vite bundles + transpiles them into
// the main/preload output. Third-party deps (effect, @effect/*, electron) stay
// external and load from node_modules as usual.
const workspacePackages = [
  "@starbase/core",
  "@starbase/contracts",
  "@starbase/cli-adapters",
  "@starbase/themes",
  "@starbase/ui"
]

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    define,
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html") }
      }
    }
  }
})
