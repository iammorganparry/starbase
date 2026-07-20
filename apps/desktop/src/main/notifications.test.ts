import type { NotificationsConfig } from "@starbase/core"
import { NOTIFICATIONS_DEFAULT } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { shouldNotify } from "./notifications.js"

/**
 * The suppression rules. These are the difference between a channel the operator
 * trusts and one they mute — so they are pure, and tested without Electron.
 */

const prefs = (over: Partial<NotificationsConfig> = {}): NotificationsConfig => ({
  ...NOTIFICATIONS_DEFAULT,
  ...over
})

describe("shouldNotify", () => {
  it("notifies when the window is in the background", () => {
    // The case the whole feature exists for.
    expect(
      shouldNotify({
        kind: "needs-input",
        windowFocused: false,
        isActiveSession: false,
        config: prefs()
      })
    ).toBe(true)
  })

  it("stays silent for the session the operator is focused on", () => {
    // They can see it. Telling them is noise, and noise is how the channel
    // gets muted wholesale — taking the alerts that mattered with it.
    expect(
      shouldNotify({
        kind: "needs-input",
        windowFocused: true,
        isActiveSession: true,
        config: prefs()
      })
    ).toBe(false)
  })

  it("still notifies for a BACKGROUND session while the window is focused", () => {
    // Parallel agents is the point: looking at session A must not silence B.
    expect(
      shouldNotify({
        kind: "done",
        windowFocused: true,
        isActiveSession: false,
        config: prefs()
      })
    ).toBe(true)
  })

  it("notifies about the open session when the WINDOW is in the background", () => {
    // "On screen" behind another app is not being watched.
    expect(
      shouldNotify({
        kind: "done",
        windowFocused: false,
        isActiveSession: true,
        config: prefs()
      })
    ).toBe(true)
  })

  it("honours the per-kind toggle", () => {
    const muted = prefs({ done: false })
    expect(
      shouldNotify({ kind: "done", windowFocused: false, isActiveSession: false, config: muted })
    ).toBe(false)
    // Muting one kind must not touch the others — that's why they're separate.
    expect(
      shouldNotify({
        kind: "needs-input",
        windowFocused: false,
        isActiveSession: false,
        config: muted
      })
    ).toBe(true)
  })

  it("the master switch silences every kind", () => {
    const off = prefs({ enabled: false })
    for (const kind of ["needs-input", "done", "failed", "pr"] as const) {
      expect(
        shouldNotify({ kind, windowFocused: false, isActiveSession: false, config: off })
      ).toBe(false)
    }
  })

  it("treats an ABSENT config as the defaults, not as silence", () => {
    // An operator who never opened Settings should still be told when an agent
    // is blocked — that is the failure the feature was built for.
    expect(
      shouldNotify({
        kind: "needs-input",
        windowFocused: false,
        isActiveSession: false,
        config: undefined
      })
    ).toBe(true)
  })
})
