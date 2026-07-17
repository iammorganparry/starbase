import { tmpdir } from "node:os"
import { join } from "node:path"

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
