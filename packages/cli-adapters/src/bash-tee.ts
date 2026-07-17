import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capOutput } from "./output-cap.js"

/**
 * Rewriting a Bash command so a copy of its output lands in a file we can watch —
 * the ONE way to see a claude command's stdout as it runs.
 *
 * claude streams assistant text token-by-token but a Bash `tool_result` arrives
 * once, whole, at exit — there is no partial-output event. So to fill a running
 * command's card live we `tee` its combined output to a temp file and tail that
 * file, emitting a `ToolDelta` per change (see `runClaude`).
 *
 * This is done inside `canUseTool`'s ALLOW branch, never a PreToolUse hook: the
 * permission decision is made against the ORIGINAL command first, and only an
 * already-allowed command is rewritten — so the tee can never turn a silently
 * allowed command into a permission prompt. If the SDK ever declined to honour a
 * changed `updatedInput.command`, the feature simply no-ops: the original runs
 * and `ToolEnd` carries the full output exactly as today.
 */

/** `'…'`-quote a path for the shell, hardening the one metacharacter single quotes don't cover. */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Only word chars survive into the filename, so a tool-use id can't escape the temp dir. */
const safeId = (toolUseId: string): string => toolUseId.replace(/[^A-Za-z0-9_-]/g, "_")

/**
 * The temp file a command's output is teed to, keyed by its tool-use id.
 *
 * Deterministic given (dir, id) — no random/time component — so the watcher, the
 * cleanup, and the tests all name the same file. `dir` defaults to the OS temp
 * dir; tests pass their own throwaway dir.
 */
export const teeLogPath = (toolUseId: string, dir: string = tmpdir()): string =>
  join(dir, `starbase-tee-${safeId(toolUseId)}.log`)

/**
 * Wrap `command` so its combined stdout+stderr is teed to `logFile` while still
 * flowing to the caller, and its REAL exit code is preserved.
 *
 * - `{ … }` groups the whole command so `a && b` tees as a unit; without the
 *   group, `a && b | tee` pipes only `b`. Newlines (not `;`) delimit the group so
 *   a command already ending in `;` or a comment doesn't break the wrapper.
 * - `2>&1` on the group merges stderr in, so the card shows what the eyes would.
 * - `tee` also writes to stdout, so what claude captures for `ToolEnd` is unchanged.
 * - `exit ${PIPESTATUS[0]}` in a subshell restores the command's status as the
 *   compound's status; a bare pipe would report tee's success and mask a failure.
 */
export const teeRewrite = (command: string, logFile: string): string =>
  `{\n${command}\n} 2>&1 | tee ${shellQuote(logFile)}\n` + "( exit ${PIPESTATUS[0]} )"

/** A running command's live-output tail: the command to run, the file being watched, and a stop. */
export interface TeeStream {
  /** The rewritten command to hand to the harness in place of the original. */
  readonly command: string
  /** The temp file the command tees to and this stream tails. */
  readonly file: string
  /** Stop polling and delete the temp file. Idempotent. */
  readonly stop: () => void
}

/**
 * Start tailing a Bash command's teed output, calling `onOutput` with the whole
 * capped snapshot each time the file grows.
 *
 * Returns the rewritten `command` to actually run (via `teeRewrite`) plus a
 * `stop`. Polling — not `fs.watch` — because the file is written by another
 * process (the harness's shell), may not exist yet when we start, and lives on a
 * temp dir where watch fidelity varies; a small poll is simpler and portable.
 * Only a genuine growth fires `onOutput`, so an unchanged snapshot is never
 * re-sent. The producer of the actual `ToolDelta` event wraps `onOutput`.
 */
export const startTeeStream = (
  toolUseId: string,
  command: string,
  onOutput: (snapshot: string) => void,
  opts: { dir?: string; pollMs?: number } = {}
): TeeStream => {
  const file = teeLogPath(toolUseId, opts.dir)
  let lastLen = -1
  let stopped = false
  const timer = setInterval(() => {
    void fs
      .readFile(file, "utf8")
      .then((text) => {
        if (stopped || text.length === lastLen) return
        lastLen = text.length
        onOutput(capOutput(text))
      })
      .catch(() => {}) // ENOENT until tee first writes — ignore.
  }, opts.pollMs ?? 150)
  // Don't let a pending poll keep the process alive past a finished run.
  timer.unref?.()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    void fs.rm(file, { force: true }).catch(() => {})
  }
  return { command: teeRewrite(command, file), file, stop }
}
