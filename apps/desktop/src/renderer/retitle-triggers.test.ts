import type { Session } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { newlyPlannedSessionIds } from "./retitle-triggers.js"

/**
 * `newlyPlannedSessionIds` is the pure trigger for retitling a session right
 * after planning. We assert it fires only on the absent → present edge (a plan
 * just appeared) and only for auto-named sessions — so a title updates once
 * there's a plan, but a manually-named session is never touched and an existing
 * plan doesn't re-fire on every render.
 */

const session = (id: string, autoTitle?: boolean): Pick<Session, "id" | "autoTitle"> => ({ id, autoTitle })

describe("newlyPlannedSessionIds", () => {
  const sessions = [session("a", true), session("b", true), session("c", false)]

  it("fires for an auto-named session whose plan just appeared", () => {
    expect(newlyPlannedSessionIds(new Set(), new Set(["a"]), sessions)).toStrictEqual(["a"])
  })

  it("does NOT re-fire for a plan that was already present", () => {
    expect(newlyPlannedSessionIds(new Set(["a"]), new Set(["a"]), sessions)).toStrictEqual([])
  })

  it("excludes a manually-named (pinned) session even when its plan just appeared", () => {
    expect(newlyPlannedSessionIds(new Set(), new Set(["c"]), sessions)).toStrictEqual([])
  })

  it("does not fire when a plan is removed (present → absent)", () => {
    expect(newlyPlannedSessionIds(new Set(["a"]), new Set(), sessions)).toStrictEqual([])
  })

  it("returns only the newly-added ids when several change at once", () => {
    expect(newlyPlannedSessionIds(new Set(["a"]), new Set(["a", "b"]), sessions)).toStrictEqual(["b"])
  })
})
