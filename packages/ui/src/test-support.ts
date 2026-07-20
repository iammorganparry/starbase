import type { Session } from "@starbase/core"

/**
 * A Session with sensible defaults, for tests and stories.
 *
 * Hoisted out of the individual suites because the same ~20-line literal was
 * being copy-pasted into every file that renders a session — which meant a
 * change to the `Session` shape had to be applied in five places, and the
 * defaults had already started to drift apart.
 *
 * `updatedAt` is a fixed date, never `new Date()`: relative-time rendering
 * ("2 hours ago") must not depend on when the suite happens to run.
 */
export const testSession = (over: Partial<Session> & { id: string }): Session =>
  ({
    repo: "gtm-grid",
    branch: `starbase/${over.id}`,
    title: over.id,
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-16T00:00:00.000Z",
    worktreePath: `/tmp/${over.id}`,
    baseBranch: "main",
    mode: "auto",
    ...over
  }) as Session
