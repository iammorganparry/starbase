import type { AdversarialReview, ReviewFinding, ReviewSeverity } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { outcomeOf } from "./review-findings.js"

/**
 * A card reports what became of its finding now that nobody clicks Send. The
 * failure mode that matters is a state which never settles: "Sending…" spins a
 * spinner AND hides the manual fallback, so a finding stuck there is both a lie
 * and unactionable. These pin which states can legitimately reach it.
 */

const finding = (severity: ReviewSeverity): ReviewFinding => ({
  id: "f1",
  path: "src/a.ts",
  line: 1,
  endLine: null,
  severity,
  title: "t",
  rationale: "r",
  suggestion: null
})

const review = (over: Partial<AdversarialReview> = {}): AdversarialReview => ({
  sessionId: "s1",
  prNumber: 7,
  headSha: "abc123",
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-17T10:00:00.000Z",
  findings: [],
  note: null,
  routedAt: null,
  postedAt: null,
  postError: null,
  ...over
})

const opts = { canRoute: true, sent: false }

describe("outcomeOf — agent-destined (critical/major)", () => {
  it("reports routed once the review carries a routedAt", () => {
    const r = review({ routedAt: "2026-07-17T10:00:01.000Z" })
    expect(outcomeOf(finding("critical"), r, opts).kind).toBe("routed")
    expect(outcomeOf(finding("major"), r, opts).kind).toBe("routed")
  })

  // The real, short window between the review landing and the stamp returning.
  it("reports pending while routing is in flight", () => {
    expect(outcomeOf(finding("critical"), review(), opts).kind).toBe("pending")
  })

  it("offers the manual fallback when there is no conversation to route through", () => {
    expect(outcomeOf(finding("critical"), review(), { canRoute: false, sent: false }).kind).toBe(
      "manual"
    )
  })
})

describe("outcomeOf — PR-destined (minor/nit)", () => {
  it("reports posted once the review carries a postedAt", () => {
    const r = review({ postedAt: "2026-07-17T10:00:02.000Z" })
    expect(outcomeOf(finding("minor"), r, opts).kind).toBe("posted")
    expect(outcomeOf(finding("nit"), r, opts).kind).toBe("posted")
  })

  it("reports the failure when the post was rejected", () => {
    const r = review({ postError: "HTTP 422" })
    const outcome = outcomeOf(finding("nit"), r, opts)
    expect(outcome.kind).toBe("post-failed")
    expect(outcome.kind === "post-failed" && outcome.message).toBe("HTTP 422")
  })

  /**
   * The regression. `Review.run` stamps postedAt or postError before the review
   * is ever returned, so an unstamped PR-destined finding can only come from a
   * review persisted BEFORE posting existed — and nothing backfills those,
   * because posting only happens on a fresh run.
   *
   * "pending" there spins forever for a post that will never come, and the
   * pending branch hides the manual fallback, so the finding becomes impossible
   * to act on. It must degrade to "manual" instead.
   */
  it("NEVER reports pending — an unstamped pre-upgrade review falls back to manual", () => {
    expect(outcomeOf(finding("minor"), review(), opts).kind).toBe("manual")
    expect(outcomeOf(finding("nit"), review(), opts).kind).toBe("manual")
  })

  it("still falls back to manual on a pre-upgrade review whose agent half HAS routed", () => {
    // routedAt gets stamped on upgrade by the routing effect; postedAt never does.
    const r = review({ routedAt: "2026-07-17T10:00:01.000Z" })
    expect(outcomeOf(finding("nit"), r, opts).kind).toBe("manual")
  })
})

describe("outcomeOf — manual sends", () => {
  it("reports routed for anything the operator sent by hand", () => {
    const sent = { canRoute: true, sent: true }
    expect(outcomeOf(finding("nit"), review(), sent).kind).toBe("routed")
    expect(outcomeOf(finding("critical"), review(), sent).kind).toBe("routed")
  })

  it("offers the button when there is no review at all", () => {
    expect(outcomeOf(finding("critical"), null, opts).kind).toBe("manual")
  })
})
