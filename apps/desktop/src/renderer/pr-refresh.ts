import type { Session, SessionStatus } from "@starbase/core"

/**
 * Session ids whose live agent run just COMPLETED between two `liveStatus`
 * snapshots — present in `prev` (running: "thinking"/"needs-input") and absent in
 * `next` (idle → the key is removed) — and that own a worktree.
 *
 * This is the trigger for App.tsx's on-completion GitHub re-check: the agent may
 * have opened AND merged its own PR during the run, which the once-per-session
 * link detection can't catch and the 60s archive poll only catches late. An
 * intermediate "thinking → needs-input" flip stays present → present and so does
 * NOT count as completion.
 */
export const completedSessionIds = (
  prev: Record<string, SessionStatus>,
  next: Record<string, SessionStatus>,
  sessions: ReadonlyArray<Session>
): ReadonlyArray<string> =>
  sessions
    .filter((s) => Boolean(s.worktreePath) && prev[s.id] != null && next[s.id] == null)
    .map((s) => s.id)
