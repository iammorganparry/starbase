import { Context } from "effect"

/**
 * Resolved filesystem locations Starbase owns, all under `~/starbase`. The Live
 * layer is provided by the Electron main process (which resolves the real home
 * directory); keeping this a `Context.Tag` lets `cli-adapters` stay
 * environment-agnostic and unit-testable with a fake path root.
 */
export interface AppPathsShape {
  /** The managed root directory, `~/starbase`. */
  readonly root: string
  /** `~/starbase/config.json` — persisted `WorkspaceConfig`. */
  readonly configFile: string
  /** `~/starbase/sessions.json` — persisted session list. */
  readonly sessionsFile: string
  /** `~/starbase/worktrees` — parent of every session's isolated worktree. */
  readonly worktreesDir: string
  /** `~/starbase/transcripts` — parent of every session's persisted transcript. */
  readonly transcriptsDir: string
  /**
   * `~/starbase/reviews` — the last adversarial review per session, at
   * `<reviewsDir>/<sessionId>.json`. Kept out of `sessions.json` on purpose: a
   * review carries an unbounded findings array, and bloating the session list
   * would slow every sidebar read.
   */
  readonly reviewsDir: string
  /**
   * `~/starbase/.starbase` — the plan library. Each session's plans live under
   * `<plansDir>/<worktree-slug>/<plan-name>.md`, so a plan can be picked back up
   * (read from disk) in a later turn or session on the same worktree.
   */
  readonly plansDir: string
  /**
   * `~/starbase/auth.enc` — the signed-in session token, encrypted with the OS
   * credential vault (Electron `safeStorage`). Only ever ciphertext is written
   * here; see `SecretStore`.
   */
  readonly authFile: string
}

export class AppPaths extends Context.Tag("@starbase/AppPaths")<AppPaths, AppPathsShape>() {}
