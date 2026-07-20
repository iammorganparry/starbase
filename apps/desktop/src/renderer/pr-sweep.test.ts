import type { PrState, Session } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { issuesToCloseOnMerge, prsToNotify } from "./pr-sweep.js"

/**
 * `issuesToCloseOnMerge` is all that survives of what used to be the "archive
 * sweep". The regression it guards: a merged PR used to auto-archive its whole
 * session, but a session holds ONE `prNumber` while routinely outliving several
 * PRs — so merging the first one made a live multi-PR session vanish from the
 * sidebar mid-flight. Merge state now only badges the row; the ONLY action left
 * on merge is closing an opted-in linked issue.
 */

const session = (over: Partial<Session> & { id: string }): Session =>
  ({
    repo: "r",
    branch: `starbase/${over.id}`,
    title: over.id,
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: 1,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-18T00:00:00.000Z",
    worktreePath: `/tmp/${over.id}`,
    ...over
  }) as unknown as Session

/** A session wired for the automation: linked issue + the opt-in flag. */
const optedIn = (id: string) =>
  session({ id, issueNumber: 7, automations: { progressComments: false, closeOnMerge: true } })

const none = new Set<string>()

describe("issuesToCloseOnMerge", () => {
  it("closes the linked issue of an opted-in session whose PR merged", () => {
    expect(issuesToCloseOnMerge({ a: "merged" }, [optedIn("a")], none)).toStrictEqual(["a"])
  })

  it("does not close anything while the PR is still open or a draft", () => {
    const sessions = [optedIn("a")]
    expect(issuesToCloseOnMerge({ a: "open" }, sessions, none)).toStrictEqual([])
    expect(issuesToCloseOnMerge({ a: "draft" }, sessions, none)).toStrictEqual([])
  })

  it("does not close the issue when the PR was CLOSED rather than merged", () => {
    // Abandoning a PR says nothing about the issue — it may well still need doing.
    expect(issuesToCloseOnMerge({ a: "closed" }, [optedIn("a")], none)).toStrictEqual([])
  })

  it("respects the opt-in: a merged PR without closeOnMerge closes nothing", () => {
    const off = session({
      id: "a",
      issueNumber: 7,
      automations: { progressComments: true, closeOnMerge: false }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [off], none)).toStrictEqual([])
  })

  it("ignores a session with no automations configured at all", () => {
    expect(issuesToCloseOnMerge({ a: "merged" }, [session({ id: "a", issueNumber: 7 })], none)).toStrictEqual([])
  })

  it("ignores an opted-in session that has no linked issue to close", () => {
    const noIssue = session({
      id: "a",
      automations: { progressComments: false, closeOnMerge: true }
    })
    expect(issuesToCloseOnMerge({ a: "merged" }, [noIssue], none)).toStrictEqual([])
  })

  it("fires once: a session already closed is never returned again", () => {
    // Load-bearing. A merged PR stays merged forever and the sweep polls on a
    // timer, so without this guard every tick would re-close the same issue.
    expect(issuesToCloseOnMerge({ a: "merged" }, [optedIn("a")], new Set(["a"]))).toStrictEqual([])
  })

  it("ignores a session with no PR state yet (nothing polled)", () => {
    expect(issuesToCloseOnMerge({}, [optedIn("a")], none)).toStrictEqual([])
  })

  it("reports every session that merged in the same tick", () => {
    const states: Record<string, PrState> = { a: "merged", b: "open", c: "merged" }
    const sessions = [optedIn("a"), optedIn("b"), optedIn("c")]
    expect(issuesToCloseOnMerge(states, sessions, none)).toStrictEqual(["a", "c"])
  })

  it("returns ONLY issue ids — merging never nominates a session for archiving", () => {
    // The behavioural heart of the fix, stated as an assertion: a merged PR on a
    // session with NO issue automation produces no work at all. There is no
    // longer any code path from "PR merged" to "session archived".
    const plain = session({ id: "multi-pr", prNumber: 204 })
    expect(issuesToCloseOnMerge({ "multi-pr": "merged" }, [plain], none)).toStrictEqual([])
  })
})

/**
 * `prsToNotify` decides which resolved PRs raise a desktop notification.
 *
 * The regression it guards is a lookup, not a policy: the first version indexed
 * this `Record<sessionId, PrState>` with the enclosing loop's numeric INDEX.
 * That is always `undefined` for a real session id, so the "PR merged/closed"
 * notification never fired — a whole kind the feature ships and exposes a
 * Settings toggle for was dead code. It typechecked, because TypeScript permits
 * numeric indexing of a `Record<string, T>`.
 */
describe("prsToNotify", () => {
  const merged = session({ id: "s1" })
  const closed = session({ id: "s2" })
  const open = session({ id: "s3" })
  const states: Record<string, PrState> = { s1: "merged", s2: "closed", s3: "open" }

  it("finds resolved PRs by SESSION ID, not by position", () => {
    // Ordered so a positional lookup can't accidentally agree: reversed here,
    // and the numeric keys 0/1/2 simply don't exist on this Record.
    const out = prsToNotify(states, [open, closed, merged], new Set())
    expect(out.map((n) => [n.session.id, n.state])).toStrictEqual([
      ["s2", "closed"],
      ["s1", "merged"]
    ])
  })

  it("ignores a PR that is still open", () => {
    expect(prsToNotify(states, [open], new Set())).toStrictEqual([])
  })

  it("ignores a session whose PR state hasn't loaded yet", () => {
    expect(prsToNotify({}, [merged], new Set())).toStrictEqual([])
  })

  it("announces each resolution once — the poll re-runs every minute", () => {
    // A merged PR stays merged forever; without this the sweep would re-announce
    // it on every tick for as long as the app is open.
    expect(prsToNotify(states, [merged], new Set(["s1"]))).toStrictEqual([])
  })
})
