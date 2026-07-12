import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { GhError, GitError } from "@starbase/core"
import { Effect, Stream } from "effect"

/** The user's home directory, from the environment (empty string if unset). */
export const home = (): Effect.Effect<string> =>
  Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE ?? "")

/** Expand a leading `~` in a path to the user's home directory. */
export const expandHome = (p: string): Effect.Effect<string> =>
  Effect.map(home(), (h) => (p.startsWith("~") ? h + p.slice(1) : p))

/**
 * Run a command and return trimmed stdout, or null on any failure (including a
 * non-zero exit). Used for detection-style probes where absence is not an error.
 */
export const runString = (
  bin: string,
  ...args: Array<string>
): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  Command.make(bin, ...args).pipe(
    Command.string,
    Effect.map((out) => {
      const trimmed = out.trim()
      return trimmed.length > 0 ? trimmed : null
    }),
    Effect.catchAll(() => Effect.succeed(null))
  )

/** Resolve a binary on PATH via `which`/`where`; returns the first hit or null. */
export const which = (
  bin: string
): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  Effect.map(
    runString(process.platform === "win32" ? "where" : "which", bin),
    (out) => out?.split("\n")[0]?.trim() ?? null
  )

/** Read a single trimmed line from `git` in `cwd`, or null on any failure. */
export const gitLine = (
  cwd: string,
  ...args: Array<string>
): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  runString("git", "-C", cwd, ...args).pipe(Effect.map((out) => out?.split("\n")[0]?.trim() ?? null))

const decodeStream = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (acc, chunk) => acc + chunk)
  )

/**
 * Run `git` and FAIL with `GitError` on a non-zero exit — used for mutating /
 * strict operations (worktree add, branch listing) where errors must surface.
 * Captures stderr for the failure message. Pass `cwd` to run in a repo, or null.
 */
export const runGit = (
  cwd: string | null,
  args: ReadonlyArray<string>
): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = Command.make("git", ...args)
      const command = cwd === null ? base : base.pipe(Command.workingDirectory(cwd))
      const proc = yield* command.pipe(Command.start)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [decodeStream(proc.stdout), decodeStream(proc.stderr), proc.exitCode],
        { concurrency: 3 }
      )
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || `git ${args.join(" ")} exited ${exitCode}`
        return yield* Effect.fail(new GitError({ message: detail }))
      }
      return stdout.trim()
    })
  ).pipe(
    Effect.catchAll((error) =>
      error instanceof GitError
        ? Effect.fail(error)
        : Effect.fail(new GitError({ message: `git ${args.join(" ")} failed`, cause: error }))
    )
  )

/**
 * Run `gh` in `cwd` and FAIL with `GhError` on a non-zero exit — used for the
 * mutating GitHub operations (`pr create`, `pr comment`, `pr review`) where a
 * failure must surface to the user. Captures stderr for the failure message.
 */
export const runGh = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<string, GhError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* Command.make("gh", ...args).pipe(
        Command.workingDirectory(cwd),
        Command.start
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [decodeStream(proc.stdout), decodeStream(proc.stderr), proc.exitCode],
        { concurrency: 3 }
      )
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || `gh ${args.join(" ")} exited ${exitCode}`
        return yield* Effect.fail(new GhError({ message: detail }))
      }
      return stdout.trim()
    })
  ).pipe(
    Effect.catchAll((error) =>
      error instanceof GhError
        ? Effect.fail(error)
        : Effect.fail(new GhError({ message: `gh ${args.join(" ")} failed`, cause: error }))
    )
  )
