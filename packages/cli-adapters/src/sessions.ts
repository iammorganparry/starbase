import type { Session } from "@starbase/core"
import { SessionNotFoundError } from "@starbase/core"
import { Effect } from "effect"

/**
 * Seed sessions mirroring the sidebar in the Starbase design (`Starbase.dc.html`
 * screen 01). Real sessions will come from a persistent store + live CLI runs;
 * for milestone 1 this gives the UI realistic data to render.
 */
const SEED: ReadonlyArray<Session> = [
  {
    id: "s_refactor_auth",
    repo: "trigify/api",
    branch: "feat/oauth",
    title: "Refactor auth flow",
    status: "thinking",
    cli: "claude",
    diff: { added: 313, removed: 23 },
    prNumber: 482,
    costUsd: 1.24,
    tokens: 218_000,
    updatedAt: "2026-07-11T09:41:00.000Z"
  },
  {
    id: "s_bump_deps",
    repo: "trigify/api",
    branch: "chore/deps",
    title: "Bump dependencies",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0.12,
    tokens: 14_200,
    updatedAt: "2026-07-11T08:12:00.000Z"
  },
  {
    id: "s_flaky_tests",
    repo: "trigify/web",
    branch: "main",
    title: "Fix flaky tests",
    status: "needs-input",
    cli: "codex",
    diff: { added: 47, removed: 9 },
    prNumber: null,
    costUsd: 0.44,
    tokens: 61_800,
    updatedAt: "2026-07-11T09:05:00.000Z"
  },
  {
    id: "s_docs_guides",
    repo: "trigify/docs",
    branch: "docs/guides",
    title: "Rewrite onboarding guides",
    status: "done",
    cli: "cursor",
    diff: { added: 128, removed: 64 },
    prNumber: 91,
    costUsd: 0.31,
    tokens: 38_400,
    updatedAt: "2026-07-10T18:20:00.000Z"
  }
]

/**
 * Read access to the set of agent sessions. In-memory and seeded for now.
 */
export class SessionStore extends Effect.Service<SessionStore>()(
  "@starbase/SessionStore",
  {
    accessors: true,
    sync: () => {
      const sessions = new Map<string, Session>(SEED.map((s) => [s.id, s]))
      return {
        list: (): Effect.Effect<ReadonlyArray<Session>> =>
          Effect.succeed([...sessions.values()]),
        get: (id: string): Effect.Effect<Session, SessionNotFoundError> => {
          const found = sessions.get(id)
          return found
            ? Effect.succeed(found)
            : Effect.fail(new SessionNotFoundError({ sessionId: id }))
        }
      }
    }
  }
) {}
