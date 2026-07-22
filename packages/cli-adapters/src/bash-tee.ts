import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { OUTPUT_CAP, OUTPUT_HEAD } from "./output-cap.js"

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

interface TeeReadHandle {
  readonly read: (offset: number, length: number) => Promise<Buffer>
  readonly close: () => Promise<void>
}

interface TeePollIo {
  readonly size: (file: string) => Promise<number>
  readonly open: (file: string) => Promise<TeeReadHandle>
  readonly remove: (file: string) => Promise<void>
}

const nodeTeePollIo: TeePollIo = {
  size: async (file) => (await fs.stat(file)).size,
  open: async (file) => {
    const handle = await fs.open(file, "r")
    return {
      read: async (offset, length) => {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      },
      close: () => handle.close()
    }
  },
  remove: async (file) => fs.rm(file, { force: true })
}

/** Bound each allocation while consuming a log that may be gigabytes long. */
const READ_CHUNK_BYTES = 64 * 1024
const OUTPUT_TAIL = OUTPUT_CAP - OUTPUT_HEAD

/**
 * Append-only capped text, retaining exactly the same head/tail snapshot shape
 * as `capOutput` without retaining the text between them.
 */
const cappedTail = () => {
  let decoder = new StringDecoder("utf8")
  let chars = 0
  let head = ""
  let tail = ""

  const reset = (): void => {
    decoder = new StringDecoder("utf8")
    chars = 0
    head = ""
    tail = ""
  }

  const push = (buffer: Buffer): void => {
    const text = decoder.write(buffer)
    if (text.length === 0) return
    chars += text.length
    if (head.length < OUTPUT_HEAD) {
      head += text.slice(0, OUTPUT_HEAD - head.length)
    }
    tail = `${tail}${text}`.slice(-OUTPUT_TAIL)
  }

  const snapshot = (): string => {
    if (chars <= OUTPUT_CAP) {
      // Before the cap, head and tail overlap. Remove that overlap to reconstruct
      // the complete text without retaining a third copy.
      const overlap = Math.max(0, head.length + tail.length - chars)
      return `${head}${tail.slice(overlap)}`
    }
    const dropped = chars - head.length - tail.length
    return `${head}\n\n… ${dropped.toLocaleString()} characters omitted …\n\n${tail}`
  }

  return { push, reset, snapshot }
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
  opts: { dir?: string; pollMs?: number; io?: TeePollIo } = {}
): TeeStream => {
  const file = teeLogPath(toolUseId, opts.dir)
  const io = opts.io ?? nodeTeePollIo
  const output = cappedTail()
  let offset = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => void poll(), opts.pollMs ?? 150)
    // Don't let a pending poll keep the process alive past a finished run.
    timer.unref?.()
  }

  const poll = async (): Promise<void> => {
    try {
      const size = await io.size(file)
      if (stopped) return
      // `tee` truncates on open. Reset if a stale file was observed before the
      // command replaced it, or if a tool-use id is unexpectedly reused.
      if (size < offset) {
        offset = 0
        output.reset()
      }
      if (size === offset) return

      const end = size
      const handle = await io.open(file)
      try {
        while (!stopped && offset < end) {
          const chunk = await handle.read(offset, Math.min(READ_CHUNK_BYTES, end - offset))
          if (chunk.length === 0) break
          offset += chunk.length
          output.push(chunk)
        }
      } finally {
        await handle.close().catch(() => {})
      }
      if (!stopped) onOutput(output.snapshot())
    } catch {
      // ENOENT until tee first writes — ignore. The next poll retries.
    } finally {
      // Schedule only after this read has settled. `setInterval` allowed reads of
      // a growing test log to overlap until hundreds of whole-file strings were
      // live at once, exhausting Electron's heap.
      schedule()
    }
  }

  schedule()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== null) clearTimeout(timer)
    void io.remove(file).catch(() => {})
  }
  return { command: teeRewrite(command, file), file, stop }
}
