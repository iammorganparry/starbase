import type { AdversarialReview, ReviewFinding, ReviewSeverity, Session } from "@starbase/core"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Auto-routing hands a review's critical/major half to the agent with nobody
 * watching, so the behaviour that matters is: exactly ONE agent turn per PR head,
 * no matter how many times (or with what stale object) the effects fire — and a
 * genuine failure still retries.
 *
 * A duplicate send is not cosmetic: it is a second agent turn against the same
 * worktree, editing the same files.
 */

const sent: Array<{ type: string; text: string }> = []
const markRoutedCalls: Array<string> = []
let markRoutedImpl: () => Promise<string | null> = async () => "2026-07-17T10:00:00.000Z"

vi.mock("./rpc-client.js", () => ({
  rpc: { reviewMarkRouted: () => markRoutedImpl() }
}))

vi.mock("./conversation-registry.js", () => ({
  getConversationActor: () => ({
    send: (event: { type: string; text: string }) => sent.push(event)
  })
}))

vi.mock("./routed-store.js", () => ({
  markRouted: (_sessionId: string, key: string) => markRoutedCalls.push(key)
}))

const { routeReviewToAgent } = await import("./auto-route.js")

const session = { id: "s1", title: "Refactor auth" } as unknown as Session

const finding = (id: string, severity: ReviewSeverity): ReviewFinding => ({
  id,
  path: "src/a.ts",
  line: 1,
  endLine: null,
  severity,
  title: `${severity} finding`,
  rationale: "because",
  suggestion: null,
  resolvedBy: null
})

const review = (over: Partial<AdversarialReview> = {}): AdversarialReview => ({
  sessionId: "s1",
  prNumber: 7,
  // Unique per test — the guard is keyed by sessionId:headSha and is
  // module-level, so a shared SHA would leak a claim across tests.
  headSha: "head-default",
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-17T10:00:00.000Z",
  findings: [finding("f1", "critical"), finding("f2", "nit")],
  note: null,
  routedAt: null,
  postedAt: null,
  postError: null,
  ...over
})

const qc = { setQueryData: () => {} } as never

beforeEach(() => {
  sent.length = 0
  markRoutedCalls.length = 0
  markRoutedImpl = async () => "2026-07-17T10:00:00.000Z"
})

describe("routeReviewToAgent", () => {
  it("sends the critical/major half as ONE turn, and no nits", async () => {
    await routeReviewToAgent(session, review({ headSha: "h-one" }), qc)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain("critical finding")
    expect(sent[0]!.text).not.toContain("nit finding")
  })

  it("does nothing for a review already stamped routed", async () => {
    await routeReviewToAgent(session, review({ headSha: "h-two", routedAt: "2026-07-17T09:00:00.000Z" }), qc)
    expect(sent).toHaveLength(0)
  })

  /**
   * The stale-object race. The stamp is written to the `["review", id]` query
   * key, but App.tsx's auto-review poll caches its own copy under
   * `["auto-review", …]` which nothing backfills — so the routing effect can
   * re-fire minutes later still holding `routedAt: null`. The claim must outlive
   * the first call or the agent gets the same prompt twice.
   */
  it("does not re-send when called again with a stale routedAt:null review", async () => {
    const stale = review({ headSha: "h-three" })
    await routeReviewToAgent(session, stale, qc)
    await routeReviewToAgent(session, stale, qc) // same object, still unstamped
    await routeReviewToAgent(session, { ...stale }, qc) // fresh identity, still unstamped
    expect(sent).toHaveLength(1)
  })

  /**
   * The second, independent guard against the "markRouted returns null → re-send
   * forever" worry. Even if the stamp came back null (it doesn't in production —
   * the store's mirror keeps it non-null — but even so), a null return takes the
   * success path, not the catch, so the claim is HELD. No re-send.
   */
  it("holds the claim and does not re-send when the stamp returns null", async () => {
    markRoutedImpl = async () => null
    const r = review({ headSha: "h-null" })
    await routeReviewToAgent(session, r, qc)
    await routeReviewToAgent(session, r, qc)
    await routeReviewToAgent(session, { ...r }, qc)
    expect(sent).toHaveLength(1)
  })

  it("does not double-send when two callers fire in the same tick", async () => {
    const r = review({ headSha: "h-four" })
    await Promise.all([routeReviewToAgent(session, r, qc), routeReviewToAgent(session, r, qc)])
    expect(sent).toHaveLength(1)
  })

  // A new head is a new review — it must route again.
  it("routes again once the PR head advances", async () => {
    await routeReviewToAgent(session, review({ headSha: "h-five" }), qc)
    await routeReviewToAgent(session, review({ headSha: "h-six" }), qc)
    expect(sent).toHaveLength(2)
  })

  /**
   * The send is irreversible and happens BEFORE the awaited stamp, so a stamp
   * failure must NOT release the claim: "retrying" would re-send a batch the
   * agent already has — a second full turn against the same worktree, which is
   * the harm this guard exists to prevent.
   *
   * Keeping the claim costs at most one re-send after a reload (the stamp never
   * persisted). Releasing it costs a guaranteed duplicate on the very next tick.
   */
  it("does NOT re-send when the stamp fails after the batch reached the agent", async () => {
    markRoutedImpl = async () => {
      throw new Error("ipc down")
    }
    const r = review({ headSha: "h-seven" })
    await routeReviewToAgent(session, r, qc)
    expect(sent).toHaveLength(1)

    markRoutedImpl = async () => "2026-07-17T10:00:00.000Z"
    await routeReviewToAgent(session, r, qc)
    expect(sent).toHaveLength(1) // still 1 — the claim held, so no duplicate turn
  })

  /**
   * The other half: a failure that dispatched NOTHING has nothing to duplicate,
   * so it stays retryable. A nits-only review sends no batch, so a failed stamp
   * there can safely be re-attempted.
   */
  it("retries the stamp when the failure dispatched nothing", async () => {
    let calls = 0
    markRoutedImpl = async () => {
      calls += 1
      throw new Error("ipc down")
    }
    const r = review({ headSha: "h-ten", findings: [finding("f1", "nit")] })
    await routeReviewToAgent(session, r, qc)
    await routeReviewToAgent(session, r, qc)
    expect(sent).toHaveLength(0)
    expect(calls).toBe(2) // the claim was released, so the stamp was re-attempted
  })

  /**
   * A review whose findings are all nits still gets stamped — otherwise this
   * re-evaluates it on every poll tick forever.
   */
  it("stamps a review with nothing to route, without sending", async () => {
    await routeReviewToAgent(
      session,
      review({ headSha: "h-eight", findings: [finding("f1", "nit")] }),
      qc
    )
    expect(sent).toHaveLength(0)
    expect(markRoutedCalls).toHaveLength(0)
  })

  it("latches each routed finding's UI state, namespaced by head SHA", async () => {
    await routeReviewToAgent(session, review({ headSha: "h-nine" }), qc)
    expect(markRoutedCalls).toStrictEqual(["review:h-nine:f1"])
  })
})
