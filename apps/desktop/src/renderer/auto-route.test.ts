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
  suggestion: null
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

  it("retries on the next tick when routing failed", async () => {
    markRoutedImpl = async () => {
      throw new Error("ipc down")
    }
    const r = review({ headSha: "h-seven" })
    await routeReviewToAgent(session, r, qc)
    expect(sent).toHaveLength(1)

    markRoutedImpl = async () => "2026-07-17T10:00:00.000Z"
    await routeReviewToAgent(session, r, qc)
    expect(sent).toHaveLength(2) // the claim was released, so it retried
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
