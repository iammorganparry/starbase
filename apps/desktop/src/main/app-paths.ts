/**
 * Provides the concrete `~/starbase` paths for the backend services. The home
 * directory is resolved from Electron (`app.getPath("home")`), keeping the
 * environment-specific bit in the main process while `cli-adapters` stays
 * platform-agnostic behind the `AppPaths` tag.
 *
 * `STARBASE_HOME` overrides the home directory when set. It lets the Playwright
 * e2e suite point the whole app at a throwaway home dir (and is handy for dev),
 * without which every launch would read/write the developer's real `~/starbase`.
 */
import { join } from "node:path"
import { app } from "electron"
import { AppPaths } from "@starbase/cli-adapters"
import { Layer } from "effect"

const home = process.env.STARBASE_HOME ?? app.getPath("home")
const root = join(home, "starbase")

export const AppPathsLive = Layer.succeed(AppPaths, {
  root,
  configFile: join(root, "config.json"),
  sessionsFile: join(root, "sessions.json"),
  worktreesDir: join(root, "worktrees")
})
