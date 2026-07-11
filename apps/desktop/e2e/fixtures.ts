import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as base } from "@playwright/test"
import type { ElectronApplication, Page } from "@playwright/test"
import { _electron as electron } from "playwright"
import { MAIN_ENTRY } from "./global-setup.js"

/** A seeded session written to sessions.json (valid `Session` shape). */
export interface SeedSession {
  readonly id: string
  readonly repo: string
  readonly branch: string
  readonly title: string
  readonly status: "idle" | "running" | "thinking" | "needs-input" | "done"
  readonly cli: "claude" | "codex" | "cursor"
  readonly diff: { added: number; removed: number }
  readonly prNumber: number | null
  readonly costUsd: number
  readonly tokens: number
  readonly updatedAt: string
  readonly worktreePath?: string
  readonly mode?: "ask" | "accept-edits" | "auto"
}

export interface LaunchOptions {
  /** Seed config.json so the app boots configured (past first-run). */
  readonly configured?: boolean
  /** Create a real git repo in the seeded repos dir (for the create-session flow). */
  readonly withRepo?: boolean
  /**
   * Seed sessions.json — either a fixed list, or a function of the launch context
   * (so a session's `worktreePath` can point at the just-created repo).
   */
  readonly sessions?:
    | ReadonlyArray<SeedSession>
    | ((ctx: { reposDir: string; repoPath: string }) => ReadonlyArray<SeedSession>)
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly window: Page
  /** The throwaway home; `~/starbase` lives at `<home>/starbase`. */
  readonly home: string
  /** The seeded repos directory (when `configured`). */
  readonly reposDir: string
  /** The seeded repo's path (when `withRepo`). */
  readonly repoPath: string
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })

const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.email", "e2e@starbase.dev"])
  git(dir, ["config", "user.name", "Starbase E2E"])
  git(dir, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(dir, "README.md"), "# e2e repo\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init", "--no-gpg-sign"])
}

export const test = base.extend<{ launchApp: (options?: LaunchOptions) => Promise<LaunchedApp> }>({
  launchApp: async ({}, use) => {
    const cleanups: Array<() => void> = []
    const apps: ElectronApplication[] = []

    const launch = async (options: LaunchOptions = {}): Promise<LaunchedApp> => {
      const home = mkdtempSync(join(tmpdir(), "starbase-e2e-home-"))
      const starbaseDir = join(home, "starbase")
      const reposDir = mkdtempSync(join(tmpdir(), "starbase-e2e-repos-"))
      cleanups.push(() => rmSync(home, { recursive: true, force: true }))
      cleanups.push(() => rmSync(reposDir, { recursive: true, force: true }))

      let repoPath = ""
      if (options.withRepo) {
        repoPath = join(reposDir, "widget")
        initRepo(repoPath)
      }

      if (options.configured) {
        mkdirSync(starbaseDir, { recursive: true })
        writeFileSync(
          join(starbaseDir, "config.json"),
          JSON.stringify({ reposDir, createdAt: "2026-07-11T00:00:00.000Z" }, null, 2)
        )
      }
      if (options.sessions) {
        const sessions =
          typeof options.sessions === "function"
            ? options.sessions({ reposDir, repoPath })
            : options.sessions
        mkdirSync(starbaseDir, { recursive: true })
        writeFileSync(join(starbaseDir, "sessions.json"), JSON.stringify(sessions, null, 2))
      }

      const app = await electron.launch({
        args: [MAIN_ENTRY],
        env: {
          ...process.env,
          STARBASE_HOME: home,
          ELECTRON_RENDERER_URL: "",
          // Force the deterministic scripted agent so chat e2e never spawns a
          // real harness (no auth, no network, reproducible).
          STARBASE_SCRIPTED_AGENT: "1"
        }
      })
      apps.push(app)
      const window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")
      return { app, window, home, reposDir, repoPath }
    }

    await use(launch)

    for (const app of apps) await app.close().catch(() => {})
    for (const cleanup of cleanups) cleanup()
  }
})

export { expect } from "@playwright/test"
