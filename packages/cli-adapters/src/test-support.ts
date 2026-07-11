/**
 * Test-only helpers for the cli-adapters suites. Not part of the package's public
 * barrel — imported directly by `*.test.ts`. Two testing strategies live here:
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
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

const appPathsFor = (root: string): AppPathsShape => ({
  root,
  configFile: join(root, "config.json"),
  sessionsFile: join(root, "sessions.json"),
  worktreesDir: join(root, "worktrees")
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
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init", "--no-gpg-sign"])
  if (options.remote) git(dir, ["remote", "add", "origin", options.remote])
  for (const b of options.branches ?? []) git(dir, ["branch", b])
  if (options.nodeModules) {
    const nm = join(dir, "node_modules")
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, ".marker"), "origin-node-modules\n")
  }
  return dir
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
 */
export type FakeCommandHandler = (
  command: string,
  args: ReadonlyArray<string>
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

/**
 * A `CommandExecutor` layer that never spawns real processes — every command is
 * resolved through `handler`. Only `start` is implemented; `makeExecutor`
 * derives `string`/`lines`/`stream`/`exitCode` from it (matching the platform).
 */
export const fakeCommandExecutor = (
  handler: FakeCommandHandler
): Layer.Layer<CommandExecutor.CommandExecutor> => {
  const executor = CommandExecutor.makeExecutor((command: Command.Command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.succeed(makeProcess({ exitCode: 0 }))
    }
    const result = handler(command.command, command.args) ?? { exitCode: 0, stdout: "" }
    return Effect.succeed(makeProcess(result))
  })
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
