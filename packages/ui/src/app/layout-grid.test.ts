import { beforeEach, describe, expect, it } from "vitest"
import {
  assign,
  clear,
  COLUMN_SPEC,
  columnsOf,
  EMPTY_LAYOUT,
  focus,
  focusedSessionId,
  type GridLayout,
  LAYOUT_LABELS,
  LAYOUT_MODES,
  LAYOUT_STORAGE_KEY,
  load,
  prune,
  save,
  setMode,
  slotIndexBySession,
  SLOT_COUNT
} from "./layout-grid.js"

/** A layout literal, so each test reads as its own starting picture. */
const layout = (
  mode: GridLayout["mode"],
  slots: ReadonlyArray<string | null>,
  focused = 0
): GridLayout => ({ mode, slots, focused })

describe("assign", () => {
  it("fills an empty slot", () => {
    const next = assign(layout("1|1", [null, null]), 1, "a")
    expect(next.slots).toEqual([null, "a"])
  })

  it("moves rather than duplicates when the session already sits elsewhere", () => {
    // The invariant that matters: one session drives exactly one pane, because
    // its conversation actor is a single registry instance.
    const next = assign(layout("2|2", ["a", "b", null, null]), 2, "a")
    expect(next.slots).toEqual([null, "b", "a", null])
  })

  it("swaps when the target slot is occupied by another session", () => {
    const next = assign(layout("1|1", ["a", "b"]), 1, "a")
    expect(next.slots).toEqual(["b", "a"])
  })

  it("replaces the occupant when the session is not already on the grid", () => {
    const next = assign(layout("1|1", ["a", "b"]), 1, "c")
    expect(next.slots).toEqual(["a", "c"])
  })

  it("is a no-op on the slot the session already holds, but still takes focus", () => {
    const before = layout("1|1", ["a", "b"], 1)
    const next = assign(before, 0, "a")
    expect(next.slots).toEqual(["a", "b"])
    expect(next.focused).toBe(0)
  })

  it("focuses the slot it assigned into", () => {
    expect(assign(layout("2|2", [null, null, null, null]), 3, "a").focused).toBe(3)
  })

  it("ignores an out-of-range slot rather than growing the array", () => {
    const before = layout("1|1", ["a", null])
    expect(assign(before, 5, "b")).toBe(before)
    expect(assign(before, -1, "b")).toBe(before)
  })
})

describe("clear", () => {
  it("empties a slot", () => {
    expect(clear(layout("1|1", ["a", "b"]), 0).slots).toEqual([null, "b"])
  })

  it("returns the same reference when the slot is already empty", () => {
    const before = layout("1|1", [null, "b"])
    expect(clear(before, 0)).toBe(before)
  })

})

describe("setMode", () => {
  it("drops the overflow when shrinking rather than compacting it", () => {
    // Deliberate: the operator arranged those panes, so relocating a session
    // they can still see is worse than dropping the ones that no longer fit.
    expect(setMode(layout("2|2", ["a", "b", "c", "d"], 3), "1|1")).toEqual({
      mode: "1|1",
      slots: ["a", "b"],
      focused: 1
    })
  })

  it("pads with empty slots when growing", () => {
    expect(setMode(layout("1", ["a"]), "2|2").slots).toEqual(["a", null, null, null])
  })

  it("clamps focus into the new range", () => {
    expect(setMode(layout("2|2", ["a", "b", "c", "d"], 3), "1").focused).toBe(0)
  })

  it("keeps focus when it still fits", () => {
    expect(setMode(layout("2|2", ["a", "b", "c", "d"], 1), "2|1").focused).toBe(1)
  })

  it("returns the same reference for the mode it is already in", () => {
    const before = layout("1|1", ["a", "b"])
    expect(setMode(before, "1|1")).toBe(before)
  })
})

describe("column shapes", () => {
  it("counts slots as the sum of its columns' rows", () => {
    expect(SLOT_COUNT["1"]).toBe(1)
    expect(SLOT_COUNT["1|1"]).toBe(2)
    expect(SLOT_COUNT["2|1"]).toBe(3)
    expect(SLOT_COUNT["1|2"]).toBe(3)
    expect(SLOT_COUNT["2|2"]).toBe(4)
  })

  it("orders slots column-major, so 2|1 is left-top, left-bottom, right", () => {
    expect(columnsOf("2|1")).toEqual([[0, 1], [2]])
  })

  it("distinguishes 1|2 from 2|1 — the split is on the other side", () => {
    expect(columnsOf("1|2")).toEqual([[0], [1, 2]])
  })

  it("splits both columns for 2|2", () => {
    expect(columnsOf("2|2")).toEqual([
      [0, 1],
      [2, 3]
    ])
  })

  it("gives every mode a label and a place in the picker", () => {
    for (const mode of LAYOUT_MODES) {
      expect(LAYOUT_LABELS[mode]).toBeTruthy()
      expect(COLUMN_SPEC[mode]).toBeTruthy()
    }
    expect(LAYOUT_MODES).toHaveLength(Object.keys(COLUMN_SPEC).length)
  })
})

describe("focus", () => {
  it("moves the focus ring", () => {
    expect(focus(layout("1|1", ["a", "b"], 0), 1).focused).toBe(1)
  })

  it("ignores an out-of-range slot", () => {
    const before = layout("1|1", ["a", "b"], 0)
    expect(focus(before, 7)).toBe(before)
  })

  it("reads the focused session, or null for an empty focused slot", () => {
    expect(focusedSessionId(layout("1|1", ["a", "b"], 1))).toBe("b")
    expect(focusedSessionId(layout("1|1", ["a", null], 1))).toBeNull()
  })
})

describe("slotIndexBySession", () => {
  it("maps each gridded session to its slot, skipping empties", () => {
    const map = slotIndexBySession(layout("2|2", ["a", null, "c", null]))
    expect(map.get("a")).toBe(0)
    expect(map.get("c")).toBe(2)
    expect(map.size).toBe(2)
  })
})

describe("prune", () => {
  it("clears slots holding sessions that no longer exist", () => {
    const next = prune(layout("2|2", ["a", "gone", "c", null]), new Set(["a", "c"]))
    expect(next.slots).toEqual(["a", null, "c", null])
  })

  it("returns the same reference when every slot is still valid", () => {
    const before = layout("1|1", ["a", null])
    expect(prune(before, new Set(["a", "b"]))).toBe(before)
  })
})

describe("persistence", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a layout", () => {
    const before = layout("2|2", ["a", null, "c", null], 2)
    save(before)
    expect(load()).toEqual(before)
  })

  it("falls back to 1-up when nothing is stored", () => {
    expect(load()).toEqual(EMPTY_LAYOUT)
  })

  it("falls back to 1-up on unparseable storage", () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, "{{ not json")
    expect(load()).toEqual(EMPTY_LAYOUT)
  })

  it("falls back to 1-up on an unknown mode", () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ mode: "7up", slots: [], focused: 0 }))
    expect(load()).toEqual(EMPTY_LAYOUT)
  })

  it("rebuilds the slot array to the mode's length when the two disagree", () => {
    // A stored layout from an older shape must not produce a grid whose slot
    // count contradicts its mode — that would render panes with no slot.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "2|2", slots: ["a"], focused: 0 })
    )
    expect(load().slots).toEqual(["a", null, null, null])
  })

  it("clamps a stored focus that is out of range", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: ["a", "b"], focused: 99 })
    )
    expect(load().focused).toBe(1)
  })

  it("upgrades a layout stored under the pre-column mode names", () => {
    // These shipped in the first cut of this feature. Falling back to 1-up would
    // silently wipe an arrangement the operator had already set up.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "2h", slots: ["a", "b"], focused: 1 })
    )
    expect(load()).toEqual({ mode: "1|1", slots: ["a", "b"], focused: 1 })
  })

  it("re-orders a legacy 2x2 from row-major to column-major", () => {
    // Old 2x2 stored TL, TR, BL, BR; columns store TL, BL, TR, BR. Without the
    // remap a restored four-pane layout would silently shuffle.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "2x2", slots: ["tl", "tr", "bl", "br"], focused: 0 })
    )
    expect(load()).toEqual({ mode: "2|2", slots: ["tl", "bl", "tr", "br"], focused: 0 })
  })

  it("maps the old three-up to two-left-one-right", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "3", slots: ["a", "b", "c"], focused: 2 })
    )
    expect(load().mode).toBe("2|1")
  })

  it("never restores the same session into two slots", () => {
    // load() is the one entry point that doesn't go through `assign`, so it is
    // the only place the one-session-one-pane invariant can be violated. Two
    // panes on one session means two subtrees fighting over one actor.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: ["s1", "s1"], focused: 0 })
    )
    expect(load().slots).toEqual(["s1", null])
  })

  it("coerces non-string slot entries to empty", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: [42, ""], focused: 0 })
    )
    expect(load().slots).toEqual([null, null])
  })
})
