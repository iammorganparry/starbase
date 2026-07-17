import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  readonly cli: "claude" | "codex" | "cursor" | "opencode"
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
  /**
   * Seed a finished reviewer's event stream, keyed by session id → the events
   * written to `~/starbase/reviews/<id>.transcript.json`. A fresh launch with one
   * of these IS the "restored after a restart" case: the app has no live reviewer,
   * so a Reviewer tab can only come from the disk.
   */
  readonly reviewTranscripts?: Record<string, ReadonlyArray<unknown>>
  /** Seed extra fixtures (e.g. project skills) after repo creation, before launch. */
  readonly seed?: (ctx: { reposDir: string; repoPath: string }) => void
  /**
   * Whether to boot past the sign-in wall (default true). When true the fixture
   * seeds a valid token so the app lands signed in; set false to assert the wall
   * itself (auth.spec).
   */
  readonly signedIn?: boolean
  /**
   * Install a deterministic fake `opencode` on PATH so discovery, the version
   * gate, the model catalogue and the provider list all run offline — instead of
   * depending on whether this host happens to have opencode installed.
   */
  readonly opencode?: {
    /** What `--version` reports. Below 1.18 the version gate must reject it. */
    readonly version?: string
    /** Providers `/config/providers` reports, mirroring the real response. */
    readonly providers?: ReadonlyArray<{
      readonly id: string
      readonly name?: string
      /** Where the credential came from; omit for "unconfigured". */
      readonly source?: "env" | "config" | "custom" | "api"
      readonly env?: ReadonlyArray<string>
      readonly models?: ReadonlyArray<string>
    }>
  }
  /**
   * Install a deterministic fake `gh` on PATH so the GitHub flows run offline:
   * `gh` reports authenticated, `gh pr list` returns these PRs, and
   * `gh pr checkout <n>` checks out the matching head branch (pre-created in the
   * repo). Lets the "new session from a PR" flow run end-to-end against real git.
   */
  readonly gh?: {
    readonly login: string
    readonly prs?: ReadonlyArray<{
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
    /** The unified diff served by `gh pr diff` (what an adversarial review reads). */
    readonly diff?: string
    /** Open issues served by `gh issue list` (for the "new session from an issue" flow). */
    readonly issues?: ReadonlyArray<{
      number: number
      title: string
      url?: string
      body?: string
      labels?: ReadonlyArray<{ name: string; color?: string }>
      author: { login: string }
      assignees?: ReadonlyArray<{ login: string }>
      updatedAt?: string
    }>
  }
}

/**
 * Install a fake `opencode` on PATH: a node shim that answers `--version` and,
 * on `serve`, boots a tiny HTTP server speaking just enough of opencode's API
 * for discovery and the model catalogue (`/config/providers`).
 *
 * Why a fake rather than the real binary: discovery probes PATH, so today's
 * model-chip tests `test.skip()` on any host without the harness installed —
 * which means the provider-switching path is untested in exactly the situation
 * that matters. A shim makes it deterministic and offline, and lets us drive the
 * cases a real install *can't* reach: a too-old version, or a provider whose key
 * is missing.
 *
 * Returns the env vars the shim reads.
 */
const installFakeOpencode = (
  binDir: string,
  opencode: NonNullable<LaunchOptions["opencode"]>
): Record<string, string> => {
  mkdirSync(binDir, { recursive: true })
  // Providers as `GET /config/providers` reports them, shaped exactly like the
  // real 1.18 response the adapter parses.
  const providers = (opencode.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    source: p.source ?? null,
    env: p.env ?? [],
    models: Object.fromEntries(
      (p.models ?? []).map((m) => [m, { id: m, name: m, providerID: p.id }])
    )
  }))

  const script = `#!/usr/bin/env node
const version = process.env.STARBASE_E2E_OPENCODE_VERSION || "1.18.0"
const providers = JSON.parse(process.env.STARBASE_E2E_OPENCODE_PROVIDERS || "[]")
const argv = process.argv.slice(2)

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(version + "\\n")
  process.exit(0)
}

if (argv[0] === "serve") {
  const http = require("node:http")
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json")
    if (req.url.startsWith("/config/providers")) {
      // The real server also returns a per-provider default; mirroring it keeps
      // the fold under test identical to production.
      const def = {}
      for (const p of providers) {
        const first = Object.keys(p.models)[0]
        if (first) def[p.id] = first
      }
      res.end(JSON.stringify({ providers, default: def }))
      return
    }
    if (req.method === "PUT" && req.url.startsWith("/auth/")) {
      // Record the write so a test can assert the key went to opencode's own
      // store rather than anywhere of Starbase's.
      const id = decodeURIComponent(req.url.slice("/auth/".length))
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        require("node:fs").appendFileSync(
          process.env.STARBASE_E2E_OPENCODE_AUTH_LOG,
          JSON.stringify({ id, body: JSON.parse(body || "{}") }) + "\\n"
        )
        res.end("true")
      })
      return
    }
    res.end("{}")
  })
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(
      "opencode server listening on http://127.0.0.1:" + server.address().port + "\\n"
    )
  })
  const bye = () => { server.close(); process.exit(0) }
  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)
  return
}
process.exit(0)
`
  const path = join(binDir, "opencode")
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return {
    STARBASE_E2E_OPENCODE_VERSION: opencode.version ?? "1.18.0",
    STARBASE_E2E_OPENCODE_PROVIDERS: JSON.stringify(providers),
    STARBASE_E2E_OPENCODE_AUTH_LOG: join(binDir, "auth-writes.jsonl")
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
   * Keys the fake opencode was asked to store, in the order it was asked. The
   * point of the assertion is WHERE a key lands: opencode's own credential
   * store, never Starbase's SecretStore.
   */
  readonly opencodeAuthWrites: () => ReadonlyArray<{ id: string; body: { type: string; key: string } }>
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
  const prs = (gh.prs ?? []).map((p) => ({
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
  const issues = (gh.issues ?? []).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.url ?? `https://github.com/acme/widget/issues/${i.number}`,
    body: i.body ?? "",
    labels: (i.labels ?? []).map((l) => ({ name: l.name, color: l.color ?? "cccccc" })),
    author: i.author,
    assignees: i.assignees ?? [],
    updatedAt: i.updatedAt ?? "2026-07-11T00:00:00Z"
  }))
  // Per-issue `gh issue view` payloads (the Issue tab fetches these).
  for (const i of issues) {
    writeFileSync(
      join(binDir, `issue-${i.number}.json`),
      JSON.stringify({
        number: i.number,
        title: i.title,
        url: i.url,
        state: "OPEN",
        body: i.body,
        author: i.author,
        assignees: i.assignees,
        labels: i.labels,
        createdAt: i.updatedAt,
        comments: []
      })
    )
  }
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
  # The adversarial-review de-dupe reads the head SHA on its own cadence, as a
  # single-field query — answer that separately from the state read above.
  case "$*" in
    *headRefOid*) printf '{"headRefOid":"e2ehead%s"}' "$3"; exit 0;;
  esac
  st=$(printf '%s' "$STARBASE_E2E_GH_STATES" | tr ',' '\\n' | awk -F: -v n="$3" '$1==n{print $2}')
  [ -z "$st" ] && st="OPEN"
  printf '{"state":"%s"}' "$st"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf '%s' "$STARBASE_E2E_GH_DIFF"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checkout" ]; then
  ref=$(printf '%s' "$STARBASE_E2E_GH_HEADS" | tr ',' '\\n' | awk -F: -v n="$3" '$1==n{print $2}')
  git checkout "$ref" >/dev/null 2>&1; exit $?
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s' "$STARBASE_E2E_GH_ISSUES"; exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  cat "$STARBASE_E2E_GH_DIR/issue-$3.json" 2>/dev/null || echo '{}'; exit 0
fi
if [ "$1" = "issue" ]; then
  exit 0
fi
exit 0
`
  const ghPath = join(binDir, "gh")
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  return {
    // A reviewer refuses to run on an empty diff (that would cache a false
    // all-clear), so `gh pr diff` has to return something real.
    STARBASE_E2E_GH_DIFF:
      gh.diff ??
      "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n const a = 1\n+const token = refresh()\n",
    STARBASE_E2E_GH_PRS: JSON.stringify(prs),
    STARBASE_E2E_GH_ISSUES: JSON.stringify(issues),
    STARBASE_E2E_GH_DIR: binDir,
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
      if (options.reviewTranscripts) {
        const dir = join(starbaseDir, "reviews")
        mkdirSync(dir, { recursive: true })
        for (const [sessionId, events] of Object.entries(options.reviewTranscripts)) {
          writeFileSync(join(dir, `${sessionId}.transcript.json`), JSON.stringify(events))
        }
      }

      // Seed extra fixtures (e.g. project skills) before launch, so they exist
      // when the app first scans them.
      options.seed?.({ reposDir, repoPath })

      // Optional fake `gh` / `opencode` on PATH (offline + deterministic). Both
      // land in the same bin dir, which is prefixed onto PATH so the shims win
      // over any real install on this host — that's what makes these tests say
      // the same thing on every machine.
      let ghEnv: Record<string, string> = {}
      let opencodeEnv: Record<string, string> = {}
      let pathPrefix = ""
      const binDir = join(home, "bin")
      if (options.gh) {
        ghEnv = installFakeGh(binDir, repoPath, options.gh)
        pathPrefix = `${binDir}:`
      }
      if (options.opencode) {
        opencodeEnv = installFakeOpencode(binDir, options.opencode)
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

      // A throwaway Chromium profile per launch. `STARBASE_HOME` isolates the
      // app's own JSON state, but NOT `localStorage` — which lives in Electron's
      // userData dir and backs the renderer's UI chrome prefs (browser-preview
      // visibility + dock side, panel widths). Without this the default profile is
      // shared by every test AND every run, so `previews.spec.ts` opening the
      // preview leaked into later tests forever: at the 1320px default window the
      // extra rail squeezed the Plan Review step spec to zero width, and its
      // assertions failed on an element that was rendered but had no box.
      const userDataDir = mkdtempSync(join(tmpdir(), "starbase-e2e-userdata-"))
      cleanups.push(() => rmSync(userDataDir, { recursive: true, force: true }))

      const app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          ...ghEnv,
          ...opencodeEnv,
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

      const opencodeAuthWrites = () => {
        const log = join(home, "bin", "auth-writes.jsonl")
        if (!existsSync(log)) return []
        return readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as { id: string; body: { type: string; key: string } })
      }

      return {
        app,
        window,
        home,
        reposDir,
        repoPath,
        authServer,
        completeDeepLinkSignIn,
        opencodeAuthWrites
      }
    }

    await use(launch)

    for (const app of apps) await app.close().catch(() => {})
    for (const cleanup of cleanups) cleanup()
  }
})

export { expect } from "@playwright/test"
