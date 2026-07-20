import type { SessionActivity } from "@starbase/core"
import { describe, expect, it } from "vitest"
import type { NotifiableState } from "./notifier.js"
import { notificationFor, prNotification } from "./notifier.js"

/**
 * The edge rules behind desktop notifications.
 *
 * What every test here defends: a conversation actor publishes a snapshot on
 * every token, so any rule phrased as "notify while X" fires thousands of times
 * for one event. Notifications are therefore TRANSITION-triggered, and the
 * interesting cases are all about not repeating yourself.
 */

const blocked = (kind: "needs-input" | "needs-approval"): SessionActivity =>
  ({ kind, verb: "Needs input", target: null }) as SessionActivity

const thinking: SessionActivity = { kind: "thinking", verb: "Thinking", target: null }

const state = (over: Partial<NotifiableState> = {}): NotifiableState => ({
  activity: null,
  outcome: null,
  ...over
})

describe("notificationFor", () => {
  it("announces the moment a session becomes blocked", () => {
    const plan = notificationFor(
      "add auth",
      state({ activity: thinking }),
      state({ activity: blocked("needs-input") })
    )
    expect(plan).toMatchObject({ kind: "needs-input", title: "add auth" })
  })

  it("says WHICH kind of blocked, because they need different things from you", () => {
    const plan = notificationFor(
      "add auth",
      state({ activity: thinking }),
      state({ activity: blocked("needs-approval") })
    )
    expect(plan?.body).toContain("approve")
  })

  it("stays silent while a session REMAINS blocked", () => {
    // The whole reason this is edge-triggered: an unanswered question is true
    // for every subsequent snapshot, and re-announcing it would be a storm.
    const stillBlocked = state({ activity: blocked("needs-input") })
    expect(notificationFor("add auth", stillBlocked, stillBlocked)).toBeNull()
  })

  it("announces a finished run once, then stays quiet", () => {
    const done = state({ outcome: "done" })
    expect(notificationFor("add auth", state(), done)).toMatchObject({ kind: "done" })
    // The outcome persists on the context until the next run starts, so the
    // value alone can't be the trigger — only the transition into it.
    expect(notificationFor("add auth", done, done)).toBeNull()
  })

  it("distinguishes a failed run from a finished one", () => {
    const plan = notificationFor("add auth", state(), state({ outcome: "failed" }))
    expect(plan).toMatchObject({ kind: "failed" })
    expect(plan?.body).toContain("failed")
  })

  it("says NOTHING on the first observation of a session", () => {
    // Actors are created at app start for sessions that may already be blocked
    // or already finished. Announcing that state would greet the operator with
    // one notification per session for things that happened before they looked.
    expect(notificationFor("add auth", null, state({ activity: blocked("needs-input") }))).toBeNull()
    expect(notificationFor("add auth", null, state({ outcome: "failed" }))).toBeNull()
  })

  it("says nothing about ordinary progress", () => {
    expect(notificationFor("add auth", state(), state({ activity: thinking }))).toBeNull()
  })

  it("announces again once a session becomes blocked a SECOND time", () => {
    // Answering a question and being asked another is two events, not one.
    const answered = state({ activity: thinking })
    expect(
      notificationFor("add auth", answered, state({ activity: blocked("needs-input") }))
    ).toMatchObject({ kind: "needs-input" })
  })
})

describe("prNotification", () => {
  it("distinguishes merged from closed — they mean opposite things", () => {
    expect(prNotification("add auth", "merged").body).toContain("merged")
    expect(prNotification("add auth", "closed").body).toContain("closed")
  })
})

describe("baseline discipline", () => {
  /**
   * These pin the rule both notification paths share: an operator is told what
   * CHANGED while they were watching, never what was already true when they
   * started watching. The registry enforces it by withholding observations until
   * the transcript has loaded; this is the shape that relies on.
   */
  it("treats the first LOADED observation as the baseline, not an edge", () => {
    // The restored transcript of a session that was blocked when the app closed.
    // If that snapshot were fed in as `next` against a null `prev`, it would read
    // as a fresh null → needs-input edge and announce stale state.
    const restored = state({ activity: blocked("needs-input") })
    expect(notificationFor("add auth", null, restored)).toBeNull()
    // Once it IS the baseline, staying blocked is still silent …
    expect(notificationFor("add auth", restored, restored)).toBeNull()
    // … and only a genuine change speaks.
    expect(notificationFor("add auth", restored, state({ activity: thinking }))).toBeNull()
    expect(
      notificationFor("add auth", state({ activity: thinking }), restored)
    ).toMatchObject({ kind: "needs-input" })
  })
})
