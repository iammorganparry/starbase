import type { ActivityKind, Session, SessionActivity } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { completedSessionIds } from "./pr-refresh.js"

/**
 * `completedSessionIds` is the pure trigger for the on-run-completion GitHub
 * re-check (link a mid-run PR + nudge the archive sweep). We assert it fires only
 * on the busy → idle edge for worktree sessions — the exact condition that made
 * an agent-merged PR previously need an app restart to show up.
 */

const session = (id: string, worktree = true): Session =>
  ({ id, worktreePath: worktree ? `/tmp/wt/${id}` : null }) as unknown as Session

/** Build an activity map from a shorthand of kinds — only presence is load-bearing. */
const status = (m: Record<string, ActivityKind>): Record<string, SessionActivity> =>
  Object.fromEntries(
    Object.entries(m).map(([id, kind]) => [id, { kind, verb: kind, target: null }])
  )

describe("completedSessionIds", () => {
  const sessions = [session("a"), session("b"), session("c")]

  it("includes a session that went from running to idle (its run just finished)", () => {
    const prev = status({ a: "thinking" })
    const next = status({}) // 'a' cleared → run complete
    expect(completedSessionIds(prev, next, sessions)).toStrictEqual(["a"])
  })

  it("ignores an intermediate thinking → needs-input flip (still running)", () => {
    const prev = status({ a: "thinking" })
    const next = status({ a: "needs-input" })
    expect(completedSessionIds(prev, next, sessions)).toStrictEqual([])
  })

  it("ignores the activity churn of a live run (reading → running → delegating)", () => {
    // Activities flip far more often than the old coarse status did; only the
    // present → absent EDGE may count as completion, never a change of activity.
    expect(completedSessionIds(status({ a: "reading" }), status({ a: "running" }), sessions)).toStrictEqual([])
    expect(
      completedSessionIds(status({ a: "running" }), status({ a: "delegating" }), sessions)
    ).toStrictEqual([])
  })

  it("ignores a session that was already idle (no transition)", () => {
    expect(completedSessionIds(status({}), status({}), sessions)).toStrictEqual([])
  })

  it("ignores a session that just STARTED running (idle → busy)", () => {
    expect(completedSessionIds(status({}), status({ a: "thinking" }), sessions)).toStrictEqual([])
  })

  it("excludes a completed session that has no worktree (nothing to link/sweep)", () => {
    const withoutWorktree = [session("a", false)]
    expect(completedSessionIds(status({ a: "running" }), status({}), withoutWorktree)).toStrictEqual([])
  })

  it("reports every session that completed in the same tick", () => {
    const prev = status({ a: "thinking", b: "running", c: "thinking" })
    const next = status({ b: "needs-input" }) // a + c finished, b still running
    expect(completedSessionIds(prev, next, sessions)).toStrictEqual(["a", "c"])
  })
})
