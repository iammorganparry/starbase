/**
 * TerminalService — the main-process manager for PTY-backed terminals.
 *
 * PERFORMANCE / MEMORY is the whole point of this file (terminals are notorious
 * for both). Three levers keep it bounded no matter how fast a process spews:
 *
 *  1. **Coalescing** — raw `pty.onData` chunks are accumulated into a `pending`
 *     buffer and flushed on a ~16 ms tick (or once ≥32 KB is buffered) as ONE
 *     `TerminalChunk`. So at most ~60 stream frames/sec/terminal reach the
 *     renderer regardless of the raw byte rate — the renderer never drowns.
 *  2. **Flow control** — the outbound `Mailbox` is bounded. If the consumer
 *     falls behind and the buffer crosses a high-water mark we `pty.pause()`
 *     (stops the OS pipe) and `pty.resume()` once it drains. Hard memory ceiling.
 *  3. **Bounded replay** — every terminal keeps only the last 256 KB of output in
 *     a ring buffer. That's what a re-attach (after a dock/session toggle)
 *     replays, and it's the ONLY thing buffered while no one is attached.
 *
 * The PTY lives here for its whole life (surviving dock toggles + session
 * switches); it is reclaimed only by `kill`, session delete, or app quit
 * (`killAll`). Nothing but already-coalesced, JSON-safe frames crosses IPC.
 */
import { spawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch"
import { basename } from "node:path"
import { randomUUID } from "node:crypto"
import { TerminalError } from "@starbase/core"
import type { TerminalChunk, TerminalInfo } from "@starbase/core"
import { Effect, Exit, Mailbox, Stream } from "effect"

/** Last-N-bytes of output kept for re-attach replay (per terminal). */
const RING_CAP = 256 * 1024
/** Coalescing flush cadence — one frame per tick at most. */
const FLUSH_MS = 16
/** Flush early once this many bytes have accumulated (bursty output stays snappy). */
const FLUSH_BYTES = 32 * 1024
/** Pause the PTY once a stalled consumer has this much buffered (hard ceiling). */
const HIGH_WATER = 4 * 1024 * 1024
/** Bounded outbound mailbox depth (frames) — backpressure kicks in past this. */
const MAILBOX_CAP = 512

/**
 * A fixed-capacity byte buffer holding the most-recent output for replay. Trims
 * whole chunks from the front (O(1) amortized); a single oversized chunk is
 * tail-sliced. This is the terminal's entire memory footprint while detached.
 */
export class RingBuffer {
  private chunks: string[] = []
  private total = 0
  constructor(private readonly cap: number) {}

  push(s: string): void {
    if (s.length === 0) return
    this.chunks.push(s)
    this.total += s.length
    while (this.total > this.cap && this.chunks.length > 1) {
      this.total -= this.chunks.shift()!.length
    }
    if (this.total > this.cap && this.chunks.length === 1) {
      const only = this.chunks[0]!
      const trimmed = only.slice(only.length - this.cap)
      this.chunks[0] = trimmed
      this.total = trimmed.length
    }
  }

  read(): string {
    return this.chunks.join("")
  }

  get size(): number {
    return this.total
  }
}

/** The live (attached) consumer bound to one `attach` stream's mailbox. */
interface LiveConsumer {
  push: (data: string) => void
  exit: (code: number) => void
  dispose: () => void
}

/** Mutable per-terminal descriptor (snapshotted into `TerminalInfo` on read). */
interface MutableInfo {
  id: string
  sessionId: string
  title: string
  cwd: string
  status: "running" | "exited"
  exitCode: number | null
}

interface Handle {
  pty: IPty
  info: MutableInfo
  ring: RingBuffer
  /** The single attached consumer, if any (null while detached). */
  live: LiveConsumer | null
}

const snapshot = (info: MutableInfo): TerminalInfo => ({ ...info })

const isWindows = process.platform === "win32"

/** The operator's login shell, falling back sensibly per platform. */
const defaultShell = (): string =>
  process.env.SHELL ?? (isWindows ? "powershell.exe" : "/bin/bash")

/**
 * Spawn as a LOGIN shell on POSIX. Electron launched from Finder/Dock inherits a
 * minimal PATH; a login shell sources the user's profile so `git`, `node`, etc.
 * resolve — exactly what a VS Code-style integrated terminal needs.
 */
const shellArgs = (): string[] => (isWindows ? [] : ["-l"])

/** process.env minus undefined values, with terminal-friendly TERM/COLORTERM. */
const shellEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  return env
}

const safePause = (pty: IPty): void => {
  try {
    pty.pause()
  } catch {
    /* pty already gone */
  }
}
const safeResume = (pty: IPty): void => {
  try {
    pty.resume()
  } catch {
    /* pty already gone */
  }
}

export interface CreateTerminalInput {
  sessionId: string
  /** Working directory; the session worktree. Defaults to the process cwd. */
  cwd?: string
  cols: number
  rows: number
}

/**
 * The service. Holds every live PTY keyed by id and exposes the lifecycle +
 * streaming seam the RPC handlers delegate to. No Effect environment required —
 * it only touches the process table + in-memory buffers.
 */
export class TerminalService extends Effect.Service<TerminalService>()("@starbase/TerminalService", {
  effect: Effect.gen(function* () {
    const handles = new Map<string, Handle>()

    const create = (input: CreateTerminalInput): Effect.Effect<TerminalInfo, TerminalError> =>
      Effect.try({
        try: () => {
          const shell = defaultShell()
          const cwd = input.cwd ?? process.cwd()
          const pty = spawn(shell, shellArgs(), {
            name: "xterm-256color",
            cols: Math.max(1, input.cols || 80),
            rows: Math.max(1, input.rows || 24),
            cwd,
            env: shellEnv()
          })
          const id = randomUUID()
          const info: MutableInfo = {
            id,
            sessionId: input.sessionId,
            title: basename(shell).replace(/\.exe$/i, ""),
            cwd,
            status: "running",
            exitCode: null
          }
          const handle: Handle = { pty, info, ring: new RingBuffer(RING_CAP), live: null }

          // Always feed the ring (bounded); fan out to the live consumer if attached.
          pty.onData((data) => {
            handle.ring.push(data)
            handle.live?.push(data)
          })
          pty.onExit(({ exitCode }) => {
            info.status = "exited"
            info.exitCode = exitCode
            handle.live?.exit(exitCode)
          })

          handles.set(id, handle)
          return snapshot(info)
        },
        catch: (cause) =>
          new TerminalError({ message: `Failed to spawn terminal shell: ${String(cause)}`, cause })
      })

    const attach = (terminalId: string): Stream.Stream<TerminalChunk, never> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const handle = handles.get(terminalId)
          if (!handle) return Stream.empty

          const mailbox = yield* Mailbox.make<TerminalChunk>(MAILBOX_CAP)

          // Already-dead terminal: replay its last screen + a final exit frame.
          if (handle.info.status === "exited") {
            const replay = handle.ring.read()
            if (replay.length > 0) mailbox.unsafeOffer({ _tag: "data", data: replay })
            mailbox.unsafeOffer({ _tag: "exit", exitCode: handle.info.exitCode ?? 0 })
            mailbox.unsafeDone(Exit.void)
            return Mailbox.toStream(mailbox)
          }

          // Register the live consumer as a scoped resource so its timer + flow
          // control are ALWAYS torn down when the stream is cancelled (detach),
          // even on interrupt. The acquire body is fully synchronous, so no PTY
          // output can slip between reading the ring and registering `live`.
          yield* Effect.acquireRelease(
            Effect.sync((): LiveConsumer => {
              handle.live?.dispose() // evict any stale consumer (renderer normally detaches first)

              const replay = handle.ring.read()
              if (replay.length > 0) mailbox.unsafeOffer({ _tag: "data", data: replay })

              let pending = ""
              let paused = false
              let ended = false

              const flush = (): void => {
                if (pending.length === 0) return
                if (mailbox.unsafeOffer({ _tag: "data", data: pending })) {
                  pending = ""
                  if (paused) {
                    safeResume(handle.pty)
                    paused = false
                  }
                } else if (!paused && pending.length >= HIGH_WATER) {
                  safePause(handle.pty)
                  paused = true
                }
              }

              const timer = setInterval(flush, FLUSH_MS)

              const consumer: LiveConsumer = {
                push: (data) => {
                  pending += data
                  if (pending.length >= FLUSH_BYTES) flush()
                  else if (!paused && pending.length >= HIGH_WATER) {
                    safePause(handle.pty)
                    paused = true
                  }
                },
                exit: (code) => {
                  flush()
                  mailbox.unsafeOffer({ _tag: "exit", exitCode: code })
                  ended = true
                  mailbox.unsafeDone(Exit.void)
                },
                dispose: () => {
                  clearInterval(timer)
                  if (paused) {
                    safeResume(handle.pty)
                    paused = false
                  }
                  if (!ended) {
                    ended = true
                    mailbox.unsafeDone(Exit.void)
                  }
                }
              }

              handle.live = consumer
              return consumer
            }),
            (consumer) =>
              Effect.sync(() => {
                consumer.dispose()
                if (handle.live === consumer) handle.live = null
              })
          )

          return Mailbox.toStream(mailbox)
        })
      )

    const write = (terminalId: string, data: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const handle = handles.get(terminalId)
        if (handle && handle.info.status === "running") handle.pty.write(data)
      })

    const resize = (terminalId: string, cols: number, rows: number): Effect.Effect<void> =>
      Effect.sync(() => {
        const handle = handles.get(terminalId)
        if (handle && handle.info.status === "running") {
          try {
            handle.pty.resize(Math.max(1, cols), Math.max(1, rows))
          } catch {
            /* pty exited between the check and the resize */
          }
        }
      })

    const kill = (terminalId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const handle = handles.get(terminalId)
        if (!handle) return
        handle.live?.dispose()
        handle.live = null
        handles.delete(terminalId)
        try {
          handle.pty.kill()
        } catch {
          /* already dead */
        }
      })

    const list = (sessionId: string): Effect.Effect<ReadonlyArray<TerminalInfo>> =>
      Effect.sync(() =>
        [...handles.values()]
          .filter((h) => h.info.sessionId === sessionId)
          .map((h) => snapshot(h.info))
      )

    const killAll: Effect.Effect<void> = Effect.sync(() => {
      for (const handle of handles.values()) {
        handle.live?.dispose()
        try {
          handle.pty.kill()
        } catch {
          /* already dead */
        }
      }
      handles.clear()
    })

    return { create, attach, write, resize, kill, list, killAll } as const
  })
}) {}
