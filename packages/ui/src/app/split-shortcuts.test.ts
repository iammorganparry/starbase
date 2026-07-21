import { describe, expect, it } from "vitest"
import { matchSplitShortcut, type SplitShortcut } from "./split-shortcuts.js"
import { MAX_PANES } from "./split-layout.js"

/**
 * Chords are built as REAL `KeyboardEvent`s and read back through the same
 * property surface the listener uses.
 *
 * Hand-rolling `{ key: "!", code: "Digit1", … }` object literals would be
 * circular: the bug this file exists for was a wrong belief about what the
 * browser puts in `key`, and a literal just re-states the belief. Naming the
 * shifted character explicitly, next to its physical key, is the point.
 */
const chord = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init)

/** ⌃⇧ + a physical key, with the character a US layout actually produces. */
const ctrlShift = (code: string, key: string, extra: KeyboardEventInit = {}) =>
  chord({ code, key, ctrlKey: true, shiftKey: true, ...extra })

const match = (e: KeyboardEvent): SplitShortcut | null => matchSplitShortcut(e)

describe("shifted chords match the physical key, not the character", () => {
  /**
   * The regression, stated as data: with Shift held, a US layout reports these
   * characters for the digit row and the brackets. Matching `e.key` against
   * "1".."4", "[" and "]" — as the first version did — can never fire.
   */
  const SHIFTED: ReadonlyArray<readonly [code: string, shiftedKey: string]> = [
    ["Digit1", "!"],
    ["Digit2", "@"],
    ["Digit3", "#"],
    ["Digit4", "$"],
    ["BracketLeft", "{"],
    ["BracketRight", "}"],
    ["Equal", "+"]
  ]

  it.each(SHIFTED)("%s reports %s with Shift, and still matches", (code, shiftedKey) => {
    const e = ctrlShift(code, shiftedKey)
    // Guard the premise itself: if a future jsdom stopped reporting the shifted
    // character, this test would otherwise pass for the wrong reason.
    expect(e.key).toBe(shiftedKey)
    expect(match(e)).not.toBeNull()
  })

  it("focuses the pane named by the digit, zero-indexed", () => {
    expect(match(ctrlShift("Digit1", "!"))).toEqual({ type: "focus-pane", index: 0 })
    expect(match(ctrlShift("Digit3", "#"))).toEqual({ type: "focus-pane", index: 2 })
  })

  it("offers a digit per pane, and no more", () => {
    expect(match(ctrlShift(`Digit${MAX_PANES}`, "$"))).toEqual({
      type: "focus-pane",
      index: MAX_PANES - 1
    })
    // One past the cap is not a pane shortcut at all — not a clamped one.
    expect(match(ctrlShift(`Digit${MAX_PANES + 1}`, "%"))).toBeNull()
  })

  it("moves focus left and right on the brackets", () => {
    expect(match(ctrlShift("BracketLeft", "{"))).toEqual({
      type: "focus-neighbour",
      direction: -1
    })
    expect(match(ctrlShift("BracketRight", "}"))).toEqual({
      type: "focus-neighbour",
      direction: 1
    })
  })

  it("adds a pane on Equal, however the layout renders it", () => {
    expect(match(ctrlShift("Equal", "+"))).toEqual({ type: "add-pane" })
    expect(match(ctrlShift("Equal", "="))).toEqual({ type: "add-pane" })
  })

  it("falls back to the character when a layout puts it on another key", () => {
    // Some layouts reach "[" from a physical key that isn't BracketLeft. The
    // character route keeps those working rather than stranding them.
    expect(match(ctrlShift("Unidentified", "["))).toEqual({
      type: "focus-neighbour",
      direction: -1
    })
  })
})

describe("the rest of the map", () => {
  it("closes the focused pane on W — and only with Shift held", () => {
    // Shift makes `key` uppercase, which the old `.toLowerCase()` handled; the
    // point here is that a BARE ⌘W is not this shortcut. Mistaking "close the
    // window" for "close the pane" is the destructive miss.
    expect(match(ctrlShift("KeyW", "W"))).toEqual({ type: "close-pane" })
    expect(match(chord({ code: "KeyW", key: "w", metaKey: true }))).toBeNull()
  })

  it("moves the focused pane on the arrows, with Alt", () => {
    expect(match(ctrlShift("ArrowLeft", "ArrowLeft", { altKey: true }))).toEqual({
      type: "move-pane",
      direction: -1
    })
    expect(match(ctrlShift("ArrowRight", "ArrowRight", { altKey: true }))).toEqual({
      type: "move-pane",
      direction: 1
    })
    // Without Alt the arrows are the composer's / the transcript's, not ours.
    expect(match(ctrlShift("ArrowLeft", "ArrowLeft"))).toBeNull()
  })

  it("opens New Session on a plain ⌘N or ⌃N", () => {
    expect(match(chord({ code: "KeyN", key: "n", metaKey: true }))).toEqual({
      type: "new-session"
    })
    expect(match(chord({ code: "KeyN", key: "n", ctrlKey: true }))).toEqual({
      type: "new-session"
    })
    // ⌃⇧N is the close-pane family's neighbour, not New Session — a modifier
    // the user added must never be ignored.
    expect(match(ctrlShift("KeyN", "N"))).toBeNull()
  })
})

describe("chords that must be left alone", () => {
  it("ignores anything without meta or ctrl", () => {
    expect(match(chord({ code: "Digit1", key: "1" }))).toBeNull()
    expect(match(chord({ code: "Digit1", key: "!", shiftKey: true }))).toBeNull()
    // Plain typing in the composer, most of all.
    expect(match(chord({ code: "KeyW", key: "w" }))).toBeNull()
  })

  it("ignores ⌘1 without Shift — that is not the pane shortcut", () => {
    expect(match(chord({ code: "Digit1", key: "1", metaKey: true }))).toBeNull()
  })
})
