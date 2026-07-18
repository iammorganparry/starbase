import { homedir } from "node:os"

/**
 * Working directories for spawned processes.
 *
 * Starbase runs many repos side by side, each session in its own git worktree.
 * The one thing every spawn must never do is INHERIT the Electron main process's
 * cwd: in development that is whichever worktree `pnpm dev` was launched from,
 * so a process belonging to repo A silently reads and writes inside repo B.
 *
 * That is not hypothetical. A user-scope MCP server probed from Settings (which
 * has no session, so no worktree) was spawned with no cwd, inherited the app's,
 * and created its SQLite database inside an unrelated repo's checkout — where it
 * then showed up as an untracked file in that repo's PR.
 *
 * So there is no "just inherit" path here. Either the caller supplies a real
 * worktree, or it gets an explicitly neutral directory that belongs to no repo.
 */

/**
 * A directory that is deliberately not any repo, for processes with no session
 * to anchor to — a user-scope MCP probe, or a terminal opened outside a session.
 *
 * The user's home is the right neutral choice rather than a temp dir: it is
 * where an interactive shell would start anyway, it is stable across runs (a
 * server that caches state finds it again), and crucially it is never a
 * checkout, so relative writes cannot land in someone's source tree.
 */
export const neutralCwd = (): string => homedir()

/**
 * The worktree a session's process must run in, or an error.
 *
 * Deliberately throws rather than falling back. A session with no worktree has
 * nothing legitimate to run — every code path that reaches here is about editing
 * a specific repo — and the only available fallback is the app's own cwd, which
 * would point the agent at Starbase's source instead. Failing loudly turns a
 * silent cross-repo write into a visible error.
 */
export const requireWorktree = (cwd: string | null | undefined, what: string): string => {
  const trimmed = cwd?.trim() ?? ""
  if (trimmed.length === 0) {
    throw new Error(
      `${what} has no worktree to run in. Refusing to fall back to the app's working directory, ` +
        "which would run it against an unrelated repository."
    )
  }
  return trimmed
}
