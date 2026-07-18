import type { ChildProcess } from "node:child_process"

/**
 * Every harness subprocess Starbase spawns, so all of them can be killed when the
 * app quits.
 *
 * POSIX does not reap a child when its parent dies — an orphan is reparented to
 * init and lives forever. `TerminalService` already learned this for PTYs, which is
 * why `before-quit` kills them explicitly. The harness servers (`opencode serve`,
 * `codex app-server`) had exactly the same hazard and no such handling.
 *
 * Each spawn site did clean up after itself on its own happy path — which is the
 * case that doesn't matter. The leak is a quit MID-FLIGHT: the `finally` never
 * runs, and the server is orphaned. Under the e2e suite, which launches and tears
 * down Electron once per test while a real `opencode` sits on PATH, that is one
 * leaked `opencode serve` per test, each holding a port and its own memory, until
 * the machine is manually cleared.
 *
 * Registering here is what makes a spawn visible to the quit path. Nothing else in
 * the process knows these children exist.
 */

const live = new Set<ChildProcess>()

/** How long a child gets to honour SIGTERM before it is killed outright. */
const GRACE_MS = 2_000

const isAlive = (proc: ChildProcess): boolean =>
  proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null

const signal = (proc: ChildProcess, sig: NodeJS.Signals): void => {
  if (!isAlive(proc)) return
  try {
    proc.kill(sig)
  } catch {
    /* already gone — the pid may have been reaped between the check and here */
  }
}

/**
 * Register a freshly-spawned child so the quit path can reach it. Returns the same
 * child, so it can wrap a `spawn(...)` call directly. Deregisters itself on exit.
 */
export const trackChild = <P extends ChildProcess>(proc: P): P => {
  live.add(proc)
  const forget = () => live.delete(proc)
  proc.once("exit", forget)
  proc.once("error", forget)
  return proc
}

/**
 * Ask a child to stop, and make sure it actually does.
 *
 * SIGTERM is only a request. opencode is a compiled Bun binary and codex an
 * app-server; neither is obliged to honour it promptly, and an unheeded SIGTERM
 * leaves behind exactly the process we were trying to reap. The follow-up SIGKILL
 * is `unref`'d so it can never hold the event loop (or a test run) open.
 */
export const stopChild = (proc: ChildProcess, graceMs: number = GRACE_MS): void => {
  if (!isAlive(proc)) return
  signal(proc, "SIGTERM")
  const timer = setTimeout(() => signal(proc, "SIGKILL"), graceMs)
  timer.unref?.()
  proc.once("exit", () => clearTimeout(timer))
}

/**
 * Kill every tracked child NOW, returning how many were still running.
 *
 * Called from `before-quit`, where there is no time to be polite: the process is
 * going away, and anything still running is about to be orphaned. SIGKILL rather
 * than SIGTERM for the same reason — we will not be here to follow up.
 */
export const killAllChildren = (): number => {
  let killed = 0
  for (const proc of live) {
    if (isAlive(proc)) killed += 1
    signal(proc, "SIGKILL")
  }
  live.clear()
  return killed
}

/** How many spawned children are currently tracked. For tests and diagnostics. */
export const liveChildCount = (): number => live.size
