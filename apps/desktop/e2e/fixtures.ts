import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as base } from "@playwright/test"
import type { ElectronApplication, Page } from "@playwright/test"
import { _electron as electron } from "playwright"
import { startFakeAuthServer, type FakeAuthServer } from "./fake-auth.js"
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
  readonly baseBranch?: string
  readonly mode?: "ask" | "accept-edits" | "auto"
  readonly archived?: boolean
  readonly archiveReason?: "merged" | "closed"
  readonly archivedAt?: string
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
  /**
   * Seed persisted transcripts, keyed by session id → the message array written to
   * `~/starbase/transcripts/<id>.json`. Lets a test load a conversation with, e.g.,
   * an orphaned pending gate (to assert it settles on load).
   */
  readonly transcripts?: Record<string, ReadonlyArray<unknown>>
  /** Seed extra fixtures (e.g. project skills) after repo creation, before launch. */
  readonly seed?: (ctx: { reposDir: string; repoPath: string }) => void
  /**
   * Whether to boot past the sign-in wall (default true). When true the fixture
   * seeds a valid token so the app lands signed in; set false to assert the wall
   * itself (auth.spec).
   */
  readonly signedIn?: boolean
  /**
   * Install a deterministic fake `gh` on PATH so the GitHub flows run offline:
   * `gh` reports authenticated, `gh pr list` returns these PRs, and
   * `gh pr checkout <n>` checks out the matching head branch (pre-created in the
   * repo). Lets the "new session from a PR" flow run end-to-end against real git.
   */
  readonly gh?: {
    readonly login: string
    readonly prs: ReadonlyArray<{
      number: number
      title: string
      headRefName: string
      baseRefName: string
      author: { login: string }
      state?: string
      isDraft?: boolean
      additions?: number
      deletions?: number
      updatedAt?: string
    }>
  }
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
  /** The offline fake auth backend this launch talks to. */
  readonly authServer: FakeAuthServer
  /**
   * Drive a `starbase://` sign-in callback into the running app (the OS would
   * normally do this after the browser flow). Emits the main-process `open-url`.
   */
  readonly completeDeepLinkSignIn: () => Promise<void>
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

/**
 * Install a fake `gh` into `binDir` and pre-create each PR's head branch in the
 * repo, so `gh pr checkout` has a real branch to switch onto. Returns the env
 * vars the shim reads (the PR-list JSON + a number→head-ref map). The shim is a
 * tiny bash script — deterministic, offline, no real GitHub.
 */
const installFakeGh = (
  binDir: string,
  repoPath: string,
  gh: NonNullable<LaunchOptions["gh"]>
): Record<string, string> => {
  mkdirSync(binDir, { recursive: true })
  const prs = gh.prs.map((p) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    author: p.author,
    state: p.state ?? "OPEN",
    isDraft: p.isDraft ?? false,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    updatedAt: p.updatedAt ?? "2026-07-11T00:00:00Z"
  }))
  // Pre-create the head branches off main so `gh pr checkout` can land on them.
  for (const p of prs) {
    if (repoPath) git(repoPath, ["branch", p.headRefName, "main"])
  }
  const heads = prs.map((p) => `${p.number}:${p.headRefName}`).join(",")
  const states = prs.map((p) => `${p.number}:${p.state}`).join(",")
  const script = `#!/usr/bin/env bash
case "$1" in
  --version) echo "gh version 2.60.0 (2026-01-01)"; exit 0;;
esac
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com" 1>&2
  echo "  ✓ Logged in to github.com account ${gh.login} (keyring)" 1>&2
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s' "$STARBASE_E2E_GH_PRS"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  st=$(printf '%s' "$STARBASE_E2E_GH_STATES" | tr ',' '\\n' | awk -F: -v n="$3" '$1==n{print $2}')
  [ -z "$st" ] && st="OPEN"
  printf '{"state":"%s"}' "$st"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checkout" ]; then
  ref=$(printf '%s' "$STARBASE_E2E_GH_HEADS" | tr ',' '\\n' | awk -F: -v n="$3" '$1==n{print $2}')
  git checkout "$ref" >/dev/null 2>&1; exit $?
fi
exit 0
`
  const ghPath = join(binDir, "gh")
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  return {
    STARBASE_E2E_GH_PRS: JSON.stringify(prs),
    STARBASE_E2E_GH_HEADS: heads,
    STARBASE_E2E_GH_STATES: states
  }
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
      if (options.transcripts) {
        const dir = join(starbaseDir, "transcripts")
        mkdirSync(dir, { recursive: true })
        for (const [sessionId, messages] of Object.entries(options.transcripts)) {
          writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(messages, null, 2))
        }
      }

      // Seed extra fixtures (e.g. project skills) before launch, so they exist
      // when the app first scans them.
      options.seed?.({ reposDir, repoPath })

      // Optional fake `gh` on PATH for the GitHub flows (offline + deterministic).
      let ghEnv: Record<string, string> = {}
      let pathPrefix = ""
      if (options.gh) {
        const binDir = join(home, "bin")
        ghEnv = installFakeGh(binDir, repoPath, options.gh)
        pathPrefix = `${binDir}:`
      }

      // Offline auth backend. Signed-in by default: seed the token file that the
      // e2e plaintext SecretStore reads, so the app boots past the wall.
      const authServer = await startFakeAuthServer()
      cleanups.push(() => void authServer.close())
      const signedIn = options.signedIn ?? true
      if (signedIn) {
        mkdirSync(starbaseDir, { recursive: true })
        writeFileSync(join(starbaseDir, "auth.enc"), authServer.token)
      }

      const app = await electron.launch({
        args: [MAIN_ENTRY],
        env: {
          ...process.env,
          ...ghEnv,
          PATH: `${pathPrefix}${process.env.PATH ?? ""}`,
          STARBASE_HOME: home,
          ELECTRON_RENDERER_URL: "",
          // Auth: talk to the offline fake backend, and store the token as a plain
          // file (no OS keychain prompts under headless Playwright).
          STARBASE_AUTH_URL: authServer.url,
          STARBASE_SECRET_STORE: "memory",
          // Force the deterministic scripted agent so chat e2e never spawns a
          // real harness (no auth, no network, reproducible).
          STARBASE_SCRIPTED_AGENT: "1"
        }
      })
      apps.push(app)
      const window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")

      const completeDeepLinkSignIn = async () => {
        await app.evaluate(
          ({ app: electronApp }, url) => {
            electronApp.emit("open-url", { preventDefault() {} }, url)
          },
          `starbase://auth/callback?token=${authServer.token}`
        )
      }

      return { app, window, home, reposDir, repoPath, authServer, completeDeepLinkSignIn }
    }

    await use(launch)

    for (const app of apps) await app.close().catch(() => {})
    for (const cleanup of cleanups) cleanup()
  }
})

export { expect } from "@playwright/test"
