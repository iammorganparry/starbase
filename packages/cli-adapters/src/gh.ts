import type { GhStatus } from "@starbase/core"
import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Stream } from "effect"
import { runString, which } from "./command.js"

const UNAVAILABLE: GhStatus = {
  available: false,
  authenticated: false,
  login: null,
  host: null,
  version: null
}

/** Run a command capturing exit code + combined stdout/stderr; never fails. */
const capture = (
  bin: string,
  args: ReadonlyArray<string>
): Effect.Effect<{ code: number; out: string }, never, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* Command.make(bin, ...args).pipe(Command.start)
      const decode = (stream: Stream.Stream<Uint8Array, unknown>) =>
        stream.pipe(Stream.decodeText(), Stream.runFold("", (acc, chunk) => acc + chunk))
      const [stdout, stderr, code] = yield* Effect.all(
        [decode(proc.stdout), decode(proc.stderr), proc.exitCode],
        { concurrency: 3 }
      )
      return { code: code as number, out: `${stdout}\n${stderr}`.trim() }
    })
  ).pipe(Effect.orElseSucceed(() => ({ code: -1, out: "" })))

/**
 * Detects the GitHub CLI (`gh`) and its auth state. Never fails — a missing or
 * unauthenticated `gh` is reported, not raised (GitHub features are optional
 * until the next milestone). `gh auth status` writes to stderr and exits 0 only
 * when a token is present, so we key authentication off the exit code.
 */
export class GhService extends Effect.Service<GhService>()(
  "@starbase/GhService",
  {
    accessors: true,
    sync: () => ({
      status: (): Effect.Effect<GhStatus, never, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const bin = yield* which("gh")
          if (bin === null) return UNAVAILABLE

          const versionRaw = yield* runString(bin, "--version")
          const firstLine = versionRaw?.split("\n")[0] ?? null
          const version = firstLine
            ? (firstLine.match(/gh version (\S+)/)?.[1] ?? firstLine)
            : null

          const auth = yield* capture(bin, ["auth", "status"])
          const authenticated = auth.code === 0
          if (!authenticated) {
            return { available: true, authenticated: false, login: null, host: null, version }
          }
          const login = auth.out.match(/(?:account|as)\s+([A-Za-z0-9-]+)/)?.[1] ?? null
          const host =
            auth.out.match(/Logged in to (\S+)/)?.[1] ??
            auth.out.match(/^\s*(\S+\.\S+)\s*$/m)?.[1] ??
            "github.com"
          return { available: true, authenticated: true, login, host, version }
        })
    })
  }
) {}
