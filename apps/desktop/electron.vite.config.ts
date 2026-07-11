import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "node:path"

// The `@starbase/*` workspace packages ship raw TypeScript source (their
// `exports` point at `src/*.ts`). Node can't run those directly in the main
// process, so we must NOT externalize them — Vite bundles + transpiles them into
// the main/preload output. Third-party deps (effect, @effect/*, electron) stay
// external and load from node_modules as usual.
const workspacePackages = [
  "@starbase/core",
  "@starbase/contracts",
  "@starbase/cli-adapters",
  "@starbase/ui"
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html") }
      }
    }
  }
})
