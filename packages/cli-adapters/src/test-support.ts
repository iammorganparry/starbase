/**
 * Test-only helpers for the cli-adapters suites. Deliberately kept OUT of the
 * package barrel (`index.ts`) so it never reaches app code; reachable from other
 * packages' tests via the explicit `@starbase/cli-adapters/test-support`
 * subpath. Two testing strategies live here:
 *
 *  1. **Real outcomes** — `withTempRoot` + `initGitRepo` run the FS/git services
 *     against a real temp `~/starbase` and real `git`, so a config actually
 *     round-trips and a worktree/branch actually gets created. This is the default
 *     because it verifies behaviour, not mocked internals.
 *  2. **Fake command output** — `fakeCommandExecutor` swaps the platform
 *     `CommandExecutor` for one that returns canned stdout/exit per command. Used
 *     only for `gh`/CLI detection, where the real binaries aren't present in CI.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandExecutor } from "@effect/platform"
import type { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import { AppPaths } from "./app-paths.js"
import type { AppPathsShape } from "./app-paths.js"

// ── Temp filesystem ──────────────────────────────────────────────────────────

export interface TempRoot {
  /** The `~/starbase` equivalent, under a unique OS temp dir. */
  readonly root: string
  /** AppPaths + real Node FileSystem/Path/CommandExecutor, ready to `Effect.provide`. */
  readonly layer: Layer.Layer<AppPaths | NodeContext.NodeContext, never, never>
  /** Remove the whole temp tree. Call in `afterEach`/`finally`. */
  readonly cleanup: () => void
}

/**
 * The `~/starbase` layout for a test root. Exported so suites that need their own
 * root don't hand-roll the literal — adding a path to `AppPathsShape` should be
 * one edit here, not one per test file (adding `reviewsDir` was three).
 */
export const appPathsFor = (root: string): AppPathsShape => ({
  root,
  configFile: join(root, "config.json"),
  sessionsFile: join(root, "sessions.json"),
  worktreesDir: join(root, "worktrees"),
  transcriptsDir: join(root, "transcripts"),
  reviewsDir: join(root, "reviews"),
  planRoundsDir: join(root, "plan-rounds"),
  plansDir: join(root, ".starbase"),
  authFile: join(root, "auth.enc")
})

/** Make a fresh OS temp dir; returns its path + a recursive cleanup. */
export const mkTemp = (prefix = "starbase-test-"): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A temp `~/starbase` root wired with the real Node platform layer. Compose it
 * under a service's `.Default` layer to exercise real FS/git outcomes.
 */
export const withTempRoot = (): TempRoot => {
  const { dir, cleanup } = mkTemp()
  const root = join(dir, "starbase")
  const layer = Layer.mergeAll(
    Layer.succeed(AppPaths, appPathsFor(root)),
    NodeContext.layer
  )
  return { root, layer, cleanup }
}

// ── Real git repos ───────────────────────────────────────────────────────────

export interface InitGitRepoOptions {
  /** `origin` remote URL to set (e.g. "git@github.com:acme/widget.git"). */
  readonly remote?: string
  /** Extra branches to create off the initial commit. */
  readonly branches?: ReadonlyArray<string>
  /** Create a `node_modules` dir (with a marker file) in the repo. */
  readonly nodeModules?: boolean
  /**
   * Build a WORKSPACE monorepo layout on top of `nodeModules`: a committed
   * `packages/lib` whose source names the branch, linked from `node_modules`
   * the way a package manager does it — `@acme/lib -> ../../packages/lib`, a
   * RELATIVE link. That relative link is the whole reason worktree dependency
   * resolution needs care, so the fixture has to reproduce it exactly.
   */
  readonly workspace?: boolean
  /** Name of the initial branch (default "main"). */
  readonly initialBranch?: string
}

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

/**
 * Initialise a real git repo at `dir` (created if needed) with one commit, and
 * optional remote / branches / node_modules. Returns `dir`. Used by the git,
 * workspace and sessions suites so their assertions are about real outcomes.
 */
export const initGitRepo = (dir: string, options: InitGitRepoOptions = {}): string => {
  const branch = options.initialBranch ?? "main"
  mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-b", branch])
  git(dir, ["config", "user.email", "test@starbase.dev"])
  git(dir, ["config", "user.name", "Starbase Test"])
  git(dir, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(dir, "README.md"), `# ${dir}\n`)
  if (options.workspace) {
    // Tracked, so `git worktree add` checks it out into the worktree — which is
    // what makes "did the link follow the branch or the origin?" observable.
    mkdirSync(join(dir, "packages", "lib"), { recursive: true })
    writeFileSync(join(dir, "packages", "lib", "index.js"), "module.exports = 'origin-source'\n")
    // A second workspace package, so a per-package node_modules has a sibling
    // to link to — the pnpm case.
    mkdirSync(join(dir, "packages", "app"), { recursive: true })
    writeFileSync(join(dir, "packages", "app", "index.js"), "module.exports = 'origin-app'\n")
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init", "--no-gpg-sign"])
  if (options.remote) git(dir, ["remote", "add", "origin", options.remote])
  for (const b of options.branches ?? []) git(dir, ["branch", b])
  if (options.nodeModules) {
    const nm = join(dir, "node_modules")
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, ".marker"), "origin-node-modules\n")
    if (options.workspace) {
      // A third-party package: branch-independent, so it should stay shared.
      mkdirSync(join(nm, "left-pad"), { recursive: true })
      writeFileSync(join(nm, "left-pad", "index.js"), "module.exports = 'vendor'\n")
      // The workspace link, RELATIVE exactly as yarn/pnpm/npm write it.
      mkdirSync(join(nm, "@acme"), { recursive: true })
      symlinkSync("../../packages/lib", join(nm, "@acme", "lib"))
      // A scoped THIRD-PARTY package sharing the scope dir with the workspace
      // link, so the fixture proves the two are told apart per-entry.
      mkdirSync(join(nm, "@acme", "vendor-kit"), { recursive: true })
      writeFileSync(join(nm, "@acme", "vendor-kit", "index.js"), "module.exports = 'vendor'\n")
      // Install STATE — the file a package manager rewrites on every install.
      writeFileSync(join(nm, ".install-state.yml"), "origin-state\n")
      // A build cache: written during ordinary work, not install.
      mkdirSync(join(nm, ".cache"), { recursive: true })
      writeFileSync(join(nm, ".cache", "build.json"), "origin-cache\n")
      // pnpm's per-package install: `packages/lib` gets its OWN node_modules,
      // holding a dep and a link to a sibling workspace package.
      const libNm = join(dir, "packages", "lib", "node_modules")
      mkdirSync(join(libNm, "dep-of-lib"), { recursive: true })
      writeFileSync(join(libNm, "dep-of-lib", "index.js"), "module.exports = 'vendor'\n")
      mkdirSync(join(libNm, "@acme"), { recursive: true })
      symlinkSync("../../../../packages/app", join(libNm, "@acme", "app"))
    }
  }
  return dir
}

/**
 * A real working repo cloned from a fresh **bare `origin`**, so
 * `refs/remotes/origin/<branch>` exists (unlike `initGitRepo`, whose `remote`
 * option only sets a URL with nothing fetchable). Returns the bare origin path;
 * advance it with `advanceOrigin` to simulate commits the clone hasn't fetched.
 */
export const initGitRepoWithOrigin = (
  dir: string,
  options: Pick<InitGitRepoOptions, "initialBranch" | "nodeModules"> = {}
): { origin: string } => {
  const branch = options.initialBranch ?? "main"
  const origin = `${dir}-origin.git`
  mkdirSync(origin, { recursive: true })
  git(origin, ["init", "--bare", "-b", branch])
  initGitRepo(dir, { initialBranch: branch, nodeModules: options.nodeModules })
  git(dir, ["remote", "add", "origin", origin])
  git(dir, ["push", "-u", "origin", branch])
  return { origin }
}

/**
 * Push a new commit onto `origin`'s `branch` via a throwaway clone, WITHOUT
 * touching any existing working clone — so a repo created by `initGitRepoWithOrigin`
 * has a stale local `origin/<branch>` until it fetches. Returns the commit subject.
 */
export const advanceOrigin = (origin: string, message: string, branch = "main"): string => {
  const { dir, cleanup } = mkTemp("starbase-origin-push-")
  try {
    const work = join(dir, "clone")
    git(dir, ["clone", origin, work])
    git(work, ["config", "user.email", "test@starbase.dev"])
    git(work, ["config", "user.name", "Starbase Test"])
    git(work, ["config", "commit.gpgsign", "false"])
    git(work, ["commit", "--allow-empty", "-m", message, "--no-gpg-sign"])
    git(work, ["push", "origin", `HEAD:${branch}`])
    return message
  } finally {
    cleanup()
  }
}

// ── Fake CommandExecutor ─────────────────────────────────────────────────────

export interface FakeCommandResult {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * A command handler: given the resolved binary + args, return canned output.
 * Returning `undefined` means "not matched" → falls through to a default of
 * `{ exitCode: 0, stdout: "" }`, which mimics a command that ran but printed
 * nothing (e.g. `which` for an absent binary is handled by matching, not here).
 *
 * `stdin` carries anything the command was `Command.feed`-ed, decoded to a
 * string ("" when nothing was). This is the only way to observe a `gh api
 * --input -` payload: the body is deliberately kept out of argv (see
 * `runGhInput`), so an argv-only handler sees a POST with no content.
 */
export type FakeCommandHandler = (
  command: string,
  args: ReadonlyArray<string>,
  stdin: string
) => FakeCommandResult | undefined

const encoder = new TextEncoder()

const streamOf = (text: string): Stream.Stream<Uint8Array, never> =>
  text.length === 0 ? Stream.empty : Stream.make(encoder.encode(text))

const makeProcess = (result: FakeCommandResult): CommandExecutor.Process => {
  const code = result.exitCode ?? 0
  const proc = {
    [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
    pid: CommandExecutor.ProcessId(1),
    exitCode: Effect.succeed(CommandExecutor.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: streamOf(result.stdout ?? ""),
    stderr: streamOf(result.stderr ?? "")
  }
  return proc as unknown as CommandExecutor.Process
}

const decoder = new TextDecoder()

/**
 * Decode a command's fed stdin to a string.
 *
 * `Command.feed` stores the body as a `Stream` on the Command itself, so it is
 * readable here — unlike the process's `stdin` sink, which this fake drains.
 * "pipe"/"inherit" (the un-fed cases) carry no body and decode to "".
 */
const stdinOf = (stdin: unknown): Effect.Effect<string> =>
  typeof stdin !== "object" || stdin === null
    ? Effect.succeed("")
    : Stream.runFold(stdin as Stream.Stream<Uint8Array, never>, "", (acc, chunk) => acc + decoder.decode(chunk)).pipe(
        Effect.orElseSucceed(() => "")
      )

/**
 * A `CommandExecutor` layer that never spawns real processes — every command is
 * resolved through `handler`. Only `start` is implemented; `makeExecutor`
 * derives `string`/`lines`/`stream`/`exitCode` from it (matching the platform).
 */
export const fakeCommandExecutor = (
  handler: FakeCommandHandler
): Layer.Layer<CommandExecutor.CommandExecutor> => {
  const executor = CommandExecutor.makeExecutor((command: Command.Command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return makeProcess({ exitCode: 0 })
      const stdin = yield* stdinOf(command.stdin)
      return makeProcess(handler(command.command, command.args, stdin) ?? { exitCode: 0, stdout: "" })
    })
  )
  return Layer.succeed(CommandExecutor.CommandExecutor, executor)
}

// ── Exit inspection ──────────────────────────────────────────────────────────

/** Run an effect to an `Exit`, providing `layer`. Mirrors gtm-grid's idiom. */
export const runExit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))

/** The typed failure value from an `Exit`, or `undefined` if it succeeded. */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined
