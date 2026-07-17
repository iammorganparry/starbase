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

const opts = { sent: false }

describe("outcomeOf — agent-destined (critical/major)", () => {
  it("reports routed once the review carries a routedAt", () => {
    const r = review({ routedAt: "2026-07-17T10:00:01.000Z" })
    expect(outcomeOf(finding("critical"), r, opts).kind).toBe("routed")
    expect(outcomeOf(finding("major"), r, opts).kind).toBe("routed")
  })

  /**
   * The heart of the "no unsupervised send on mount" fix. An unrouted agent
   * finding reads "Send to agent" (manual) — never a "Sending…" spinner. There
   * is no honest in-flight state a card can derive from an absent stamp:
   * "pending" could not tell a fresh run a moment from settling apart from a
   * pre-upgrade review that will never settle, so it spun forever and, worse,
   * hid the fallback. Unstamped = the operator's call.
   */
  it("reports manual for an unrouted agent finding — never a pending spinner", () => {
    expect(outcomeOf(finding("critical"), review(), opts).kind).toBe("manual")
    expect(outcomeOf(finding("major"), review(), opts).kind).toBe("manual")
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
   * because posting only happens on a fresh run. It must read "manual", not spin.
   */
  it("reports manual for an unstamped pre-upgrade review — never a pending spinner", () => {
    expect(outcomeOf(finding("minor"), review(), opts).kind).toBe("manual")
    expect(outcomeOf(finding("nit"), review(), opts).kind).toBe("manual")
  })

  it("still reports manual on a pre-upgrade review whose agent half HAS routed", () => {
    // A pre-upgrade review can carry routedAt (stamped once) but never postedAt.
    const r = review({ routedAt: "2026-07-17T10:00:01.000Z" })
    expect(outcomeOf(finding("nit"), r, opts).kind).toBe("manual")
  })
})

describe("outcomeOf — manual sends", () => {
  it("reports routed for anything the operator sent by hand", () => {
    const sent = { sent: true }
    expect(outcomeOf(finding("nit"), review(), sent).kind).toBe("routed")
    expect(outcomeOf(finding("critical"), review(), sent).kind).toBe("routed")
  })

  it("offers the button when there is no review at all", () => {
    expect(outcomeOf(finding("critical"), null, opts).kind).toBe("manual")
  })
})
