import type { Session, SessionActivity } from "@starbase/core"

/**
 * Session ids whose live agent run just COMPLETED between two `liveActivity`
 * snapshots — present in `prev` (the agent was doing something) and absent in
 * `next` (idle → the key is removed) — and that own a worktree.
 *
 * This is the trigger for App.tsx's on-completion GitHub re-check: the agent may
 * have opened AND merged its own PR during the run, which the once-per-session
 * link detection can't catch and the 60s archive poll only catches late. Only
 * presence matters, never the activity itself — every intermediate flip
 * ("Thinking" → "Running npm test" → "Needs input") stays present → present and
 * so does NOT count as completion.
 */
export const completedSessionIds = (
  prev: Record<string, SessionActivity>,
  next: Record<string, SessionActivity>,
  sessions: ReadonlyArray<Session>
): ReadonlyArray<string> =>
  sessions
    .filter((s) => Boolean(s.worktreePath) && prev[s.id] != null && next[s.id] == null)
    .map((s) => s.id)
