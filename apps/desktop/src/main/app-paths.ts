/**
 * Provides the concrete `~/starbase` paths for the backend services. The home
 * directory is resolved from Electron (`app.getPath("home")`), keeping the
 * environment-specific bit in the main process while `cli-adapters` stays
 * platform-agnostic behind the `AppPaths` tag.
 */
import { join } from "node:path"
import { app } from "electron"
import { AppPaths } from "@starbase/cli-adapters"
import { Layer } from "effect"

const root = join(app.getPath("home"), "starbase")

export const AppPathsLive = Layer.succeed(AppPaths, {
  root,
  configFile: join(root, "config.json"),
  sessionsFile: join(root, "sessions.json"),
  worktreesDir: join(root, "worktrees")
})
