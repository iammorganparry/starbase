import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(here, "..")
export const MAIN_ENTRY = resolve(DESKTOP_ROOT, "out/main/index.js")

/**
 * Build the Electron app once before the suite so specs can launch the real
 * bundled `out/main/index.js`. Set `SKIP_E2E_BUILD=1` to reuse an existing build
 * (fast local iteration).
 */
export default function globalSetup(): void {
  if (process.env.SKIP_E2E_BUILD === "1" && existsSync(MAIN_ENTRY)) {
    return
  }
  execSync("pnpm exec electron-vite build", { cwd: DESKTOP_ROOT, stdio: "inherit" })
}
