import { describe, expect, it } from "vitest"
import { clampDockWidth, DOCK_RIGHT_MIN_SHELL, effectiveDock } from "./dock-fit.js"
import { maxPanesForWidth, MAX_PANES, MIN_PANE_PX } from "./split-layout.js"

describe("effectiveDock", () => {
  it("honours a right dock when the shell can seat one", () => {
    expect(effectiveDock("right", 1600)).toBe("right")
  })

  it("forces a narrow shell's right dock to the bottom", () => {
    expect(effectiveDock("right", 900)).toBe("bottom")
  })

  it("leaves a bottom dock alone — height is the axis the shell has to spare", () => {
    expect(effectiveDock("bottom", 700)).toBe("bottom")
  })

  it("honours the preference while the shell is unmeasured", () => {
    // Width 0 is the pre-observation frame. Flipping to bottom and back on every
    // launch would be worse than being briefly wrong.
    expect(effectiveDock("right", 0)).toBe("right")
  })

  it("treats the threshold as wide enough", () => {
    expect(effectiveDock("right", DOCK_RIGHT_MIN_SHELL)).toBe("right")
    expect(effectiveDock("right", DOCK_RIGHT_MIN_SHELL - 1)).toBe("bottom")
  })
})

describe("clampDockWidth", () => {
  it("caps a dock at 40% of the row", () => {
    expect(clampDockWidth(920, 1000)).toBe(400)
  })

  it("leaves a dock that already fits alone", () => {
    expect(clampDockWidth(300, 2000)).toBe(300)
  })

  it("passes the stored width through while unmeasured", () => {
    expect(clampDockWidth(480, 0)).toBe(480)
  })
})

describe("maxPanesForWidth", () => {
  it("seats the full cap on a wide row", () => {
    expect(maxPanesForWidth(MIN_PANE_PX * MAX_PANES)).toBe(MAX_PANES)
  })

  it("refuses a fourth pane the row cannot make readable", () => {
    // `MIN_RATIO` is a proportion, not a floor: 0.15 of a 1174px row is ~176px,
    // narrower than a diff row's fixed gutters. This is the floor.
    expect(maxPanesForWidth(1000)).toBe(2)
    expect(maxPanesForWidth(700)).toBe(2)
    expect(maxPanesForWidth(400)).toBe(1)
  })

  it("never returns zero, and never exceeds the static cap", () => {
    expect(maxPanesForWidth(10)).toBe(1)
    expect(maxPanesForWidth(99_999)).toBe(MAX_PANES)
  })

  it("yields the static cap while unmeasured, so ⌃⇧= doesn't fail on launch", () => {
    expect(maxPanesForWidth(0)).toBe(MAX_PANES)
  })
})
