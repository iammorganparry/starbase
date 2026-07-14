import type { Session } from "@starbase/core"
import { beforeEach, describe, expect, it } from "vitest"
import { markBabysat, resetBabysat, shouldBabysit, wasBabysat } from "./babysit-store.js"

/**
 * `babysit-store` is the idempotency guard behind auto-babysit. `shouldBabysit` is
 * the pure gate the App.tsx completion effect consults before injecting a babysit
 * turn; `markBabysat`/`wasBabysat` make it one-shot per (session, PR). The failure
 * we're guarding against: without the guard, the babysit turn's own completion
 * re-fires PR detection → re-injects babysit forever.
 */

const session = (over: Partial<Session> = {}): Session =>
  ({ id: "s1", archived: false, baseBranch: "main", ...over }) as unknown as Session

const opts = (over: Partial<Parameters<typeof shouldBabysit>[0]> = {}) => ({
  session: session(),
  prNumber: 42,
  autoBabysitPr: true,
  connected: true,
  ...over
})

describe("babysit-store", () => {
  beforeEach(() => resetBabysat())

  it("markBabysat / wasBabysat track a (session, PR) pair", () => {
    expect(wasBabysat("s1", 42)).toBe(false)
    markBabysat("s1", 42)
    expect(wasBabysat("s1", 42)).toBe(true)
    // A different PR on the same session is independent.
    expect(wasBabysat("s1", 43)).toBe(false)
    // A different session with the same PR number is independent.
    expect(wasBabysat("s2", 42)).toBe(false)
  })

  describe("shouldBabysit", () => {
    it("is true on the happy path (setting on, connected, open, not yet babysat)", () => {
      expect(shouldBabysit(opts())).toBe(true)
    })

    it("is false when the setting is off", () => {
      expect(shouldBabysit(opts({ autoBabysitPr: false }))).toBe(false)
    })

    it("is false when GitHub is not connected", () => {
      expect(shouldBabysit(opts({ connected: false }))).toBe(false)
    })

    it("is false for an archived session", () => {
      expect(shouldBabysit(opts({ session: session({ archived: true }) }))).toBe(false)
    })

    it("is false once the PR has already been babysat (idempotency)", () => {
      markBabysat("s1", 42)
      expect(shouldBabysit(opts())).toBe(false)
    })
  })
})
