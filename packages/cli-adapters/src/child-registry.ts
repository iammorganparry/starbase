import type { ChildProcess } from "node:child_process"

/**
 * Every CLI child this process has spawned and not yet seen exit.
 *
 * The point is app teardown. On POSIX a child is NOT reaped when its parent
 * dies — it is reparented to launchd/init and keeps running. Each spawn site
 * here already kills its own child on the way out (`finally`, an abort, a
 * timeout guard), and that is correct as far as it goes: it covers the run
 * ending. What it cannot cover is the run NOT ending — the main process going
 * away underneath it, at which point the `finally` never executes and the child
 * is orphaned for good.
 *
 * That is not hypothetical. Every orphan found while diagnosing this had PPID 1:
 *
 *     $ ps -o pid,ppid,command -p 65451
 *       PID  PPID COMMAND
 *     65451     1 /opt/homebrew/bin/opencode serve --hostname=127.0.0.1 --port=0
 *
 * An `opencode serve` holds ~100MB and never exits on its own, so they
 * accumulate — hundreds of them across a day of `pnpm dev`, where electron-vite
 * restarts the main process on every edit to it. `TerminalService.killAll`
 * already reaps PTYs on quit for exactly this reason; this is the same idea for
 * everything else we spawn.
 *
 * Registration is per-child and self-cleaning, so this set tracks what is
 * actually alive rather than growing into a leak of its own.
 */
const children = new Set<ChildProcess>()

/**
 * Track `child` until it exits, so `killTrackedChildren` can reap it if the app
 * goes down first. Returns the child, so it can wrap a `spawn` call in place.
 *
 * A child that never started (no pid — `spawn` failed) is not tracked: there is
 * nothing to signal, and its `error` event may already have fired.
 */
export const trackChild = <T extends ChildProcess>(child: T): T => {
  if (child.pid === undefined) return child
  children.add(child)
  const forget = (): void => {
    children.delete(child)
  }
  // Both, not just `exit`: a child that fails to spawn emits only `error`, and
  // leaving it here would mean signalling a pid that was never ours.
  child.once("exit", forget)
  child.once("error", forget)
  return child
}

/**
 * Signal every tracked child. Best-effort and synchronous, so it is safe to call
 * from `before-quit` and from a `process.on("exit")` handler — neither of which
 * can await anything.
 *
 * Signal delivery does not depend on us sticking around to watch it land: once
 * the signal is queued the child dies on its own schedule, even if this process
 * exits in the same tick. Returns how many were signalled, which is what the
 * tests assert on.
 */
export const killTrackedChildren = (signal: NodeJS.Signals = "SIGTERM"): number => {
  let killed = 0
  // Iterate a copy: `kill` can land an exit synchronously, and `forget` mutates
  // the set we would otherwise be iterating.
  for (const child of [...children]) {
    children.delete(child)
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      child.kill(signal)
      killed += 1
    } catch {
      // Already gone, or the pid was recycled out from under us. Nothing to do:
      // this runs during teardown, where there is nobody left to tell.
    }
  }
  return killed
}

/** How many children are currently tracked. For tests. */
export const trackedChildCount = (): number => children.size
