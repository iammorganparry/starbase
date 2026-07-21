import { beforeEach, describe, expect, it } from "vitest"
import {
  activate,
  activeGroup,
  closePane,
  EMPTY_WORKSPACE,
  focusAdjacent,
  focusedSessionId,
  focusPane,
  groupOf,
  load,
  MAX_PANES,
  migrateLegacyLayout,
  MIN_RATIO,
  movePane,
  prune,
  replacePane,
  resize,
  save,
  separateAll,
  show,
  splitWith,
  visibleSessionIds,
  type Workspace
} from "./split-layout.js"

/** Build a workspace by showing sessions in order, then splitting them together. */
const workspaceOf = (...groups: ReadonlyArray<ReadonlyArray<string>>): Workspace =>
  groups.reduce<Workspace>((ws, ids) => {
    const seeded = show(ws, ids[0]!)
    const groupId = groupOf(seeded, ids[0]!)!.id
    return ids.slice(1).reduce((acc, id, i) => splitWith(acc, groupId, id, i + 1), seeded)
  }, EMPTY_WORKSPACE)

const paneIds = (ws: Workspace, groupId?: string): ReadonlyArray<string> =>
  (groupId ? ws.groups.find((g) => g.id === groupId) : activeGroup(ws))!.panes.map((p) => p.sessionId)

const ratiosSumToOne = (ws: Workspace): boolean =>
  ws.groups.every((g) => Math.abs(g.panes.reduce((s, p) => s + p.ratio, 0) - 1) < 1e-6)

describe("show", () => {
  it("makes an unseen session its own single-pane group", () => {
    const ws = show(EMPTY_WORKSPACE, "a")
    expect(ws.groups).toHaveLength(1)
    expect(paneIds(ws)).toEqual(["a"])
    expect(focusedSessionId(ws)).toBe("a")
  })

  it("leaves the split it is looking at intact when showing another session", () => {
    const ws = show(workspaceOf(["a", "b"]), "c")
    expect(ws.groups).toHaveLength(2)
    expect(paneIds(ws, ws.groups[0]!.id)).toEqual(["a", "b"])
    expect(focusedSessionId(ws)).toBe("c")
  })

  it("focuses a session in place rather than moving it — a click is not a drag", () => {
    const split = workspaceOf(["a", "b"])
    const ws = show(split, "b")
    expect(ws.groups).toHaveLength(1)
    expect(paneIds(ws)).toEqual(["a", "b"])
    expect(focusedSessionId(ws)).toBe("b")
  })
})

describe("splitWith", () => {
  it("inserts at the requested index and focuses the new pane", () => {
    const ws = workspaceOf(["a", "b"])
    const next = splitWith(ws, ws.groups[0]!.id, "c", 1)
    expect(paneIds(next)).toEqual(["a", "c", "b"])
    expect(focusedSessionId(next)).toBe("c")
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("moves a session rather than duplicating it — one session, one pane", () => {
    const ws = workspaceOf(["a", "b"], ["c"])
    const target = ws.groups[0]!.id
    const next = splitWith(ws, target, "c", 2)
    expect(paneIds(next, next.groups[0]!.id)).toEqual(["a", "b", "c"])
    // "c"'s old single-pane group emptied and was dropped, not left behind.
    expect(next.groups).toHaveLength(1)
    const everywhere = next.groups.flatMap((g) => g.panes.map((p) => p.sessionId))
    expect(new Set(everywhere).size).toBe(everywhere.length)
  })

  it("refuses past MAX_PANES instead of evicting a pane the operator arranged", () => {
    const ws = workspaceOf(["a", "b", "c", "d"])
    expect(ws.groups[0]!.panes).toHaveLength(MAX_PANES)
    const next = splitWith(ws, ws.groups[0]!.id, "e", 4)
    expect(next).toBe(ws)
  })

  it("is a no-op when the session is already in that split", () => {
    const ws = workspaceOf(["a", "b"])
    const next = splitWith(ws, ws.groups[0]!.id, "b", 0)
    expect(paneIds(next)).toEqual(["a", "b"])
    expect(focusedSessionId(next)).toBe("b")
  })

  it("gives every pane an equal share", () => {
    const ws = workspaceOf(["a", "b", "c"])
    expect(ws.groups[0]!.panes.every((p) => Math.abs(p.ratio - 1 / 3) < 1e-6)).toBe(true)
  })
})

describe("replacePane", () => {
  // The regression this reducer exists for: group ids derive from the LEFTMOST
  // pane, so a close-then-insert pair loses the session when index is 0.
  it("swaps the leftmost pane, the case a close-then-insert pair silently dropped", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = replacePane(ws, ws.groups[0]!.id, 0, "z")
    expect(paneIds(next)).toEqual(["z", "b", "c"])
    expect(next.activeGroupId).toBe(next.groups[0]!.id)
    expect(focusedSessionId(next)).toBe("z")
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("swaps a middle pane without disturbing its neighbours", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = replacePane(ws, ws.groups[0]!.id, 1, "z")
    expect(paneIds(next)).toEqual(["a", "z", "c"])
    expect(focusedSessionId(next)).toBe("z")
  })

  it("moves the dropped session out of the group it came from", () => {
    const ws = workspaceOf(["a", "b"], ["c", "d"])
    const next = replacePane(ws, ws.groups[0]!.id, 0, "c")
    expect(paneIds(next, next.groups[0]!.id)).toEqual(["c", "b"])
    expect(paneIds(next, next.groups[1]!.id)).toEqual(["d"])
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("shrinks the group rather than duplicating when the session is already in it", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = replacePane(ws, ws.groups[0]!.id, 2, "a")
    expect(paneIds(next)).toEqual(["b", "a"])
    expect(focusedSessionId(next)).toBe("a")
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("is a no-op on the pane already showing that session", () => {
    const ws = workspaceOf(["a", "b"])
    expect(replacePane(ws, ws.groups[0]!.id, 1, "b")).toEqual(ws)
  })

  it("ignores an unknown group or an out-of-range pane", () => {
    const ws = workspaceOf(["a", "b"])
    expect(replacePane(ws, "g:nope", 0, "z")).toBe(ws)
    expect(replacePane(ws, ws.groups[0]!.id, 5, "z")).toBe(ws)
  })
})

describe("closePane", () => {
  it("leaves a one-pane group, never an empty hole", () => {
    const ws = closePane(workspaceOf(["a", "b"]), workspaceOf(["a", "b"]).groups[0]!.id, 1)
    expect(ws.groups).toHaveLength(1)
    expect(paneIds(ws)).toEqual(["a"])
    expect(ratiosSumToOne(ws)).toBe(true)
  })

  it("renormalises the survivors so no gap is left in the row", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = closePane(ws, ws.groups[0]!.id, 0)
    expect(ratiosSumToOne(next)).toBe(true)
    expect(next.groups[0]!.panes.every((p) => Math.abs(p.ratio - 0.5) < 1e-6)).toBe(true)
  })

  it("drops the group entirely when its last pane closes", () => {
    const ws = show(EMPTY_WORKSPACE, "a")
    const next = closePane(ws, ws.groups[0]!.id, 0)
    expect(next.groups).toHaveLength(0)
    expect(next.activeGroupId).toBeNull()
  })

  it("moves focus to the left neighbour when the focused pane closes", () => {
    const ws = focusPane(workspaceOf(["a", "b", "c"]), workspaceOf(["a", "b", "c"]).groups[0]!.id, 2)
    const next = closePane(ws, ws.groups[0]!.id, 2)
    expect(focusedSessionId(next)).toBe("b")
  })

  it("activates a surviving group when the active one is closed away", () => {
    const ws = activate(workspaceOf(["a"], ["b"]), workspaceOf(["a"], ["b"]).groups[1]!.id)
    const next = closePane(ws, ws.groups[1]!.id, 0)
    expect(next.activeGroupId).toBe(next.groups[0]!.id)
  })
})

describe("movePane", () => {
  it("swaps with the neighbour and follows the moved pane with focus", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = movePane(ws, ws.groups[0]!.id, 0, 1)
    expect(paneIds(next)).toEqual(["b", "a", "c"])
    expect(focusedSessionId(next)).toBe("a")
  })

  it("is a no-op at either end rather than wrapping", () => {
    const ws = workspaceOf(["a", "b"])
    expect(movePane(ws, ws.groups[0]!.id, 0, -1)).toBe(ws)
    expect(movePane(ws, ws.groups[0]!.id, 1, 1)).toBe(ws)
  })
})

describe("separateAll", () => {
  it("explodes a split into single-pane groups, order preserved", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = separateAll(ws, ws.groups[0]!.id)
    expect(next.groups.map((g) => g.panes[0]!.sessionId)).toEqual(["a", "b", "c"])
    expect(next.groups.every((g) => g.panes.length === 1)).toBe(true)
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("keeps you looking at the pane that had focus", () => {
    const base = workspaceOf(["a", "b", "c"])
    const ws = focusPane(base, base.groups[0]!.id, 1)
    const next = separateAll(ws, ws.groups[0]!.id)
    expect(focusedSessionId(next)).toBe("b")
  })

  it("keeps its place in the sidebar list", () => {
    const ws = workspaceOf(["a"], ["b", "c"], ["d"])
    const next = separateAll(ws, ws.groups[1]!.id)
    expect(next.groups.map((g) => g.panes[0]!.sessionId)).toEqual(["a", "b", "c", "d"])
  })

  it("does nothing to a group that isn't a split", () => {
    const ws = show(EMPTY_WORKSPACE, "a")
    expect(separateAll(ws, ws.groups[0]!.id)).toBe(ws)
  })
})

describe("resize", () => {
  it("moves only the divider's two neighbours", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = resize(ws, ws.groups[0]!.id, 0, 0.1)
    const [a, b, c] = next.groups[0]!.panes
    expect(a!.ratio).toBeCloseTo(1 / 3 + 0.1, 6)
    expect(b!.ratio).toBeCloseTo(1 / 3 - 0.1, 6)
    // The pane on the far side of the row is untouched.
    expect(c!.ratio).toBeCloseTo(1 / 3, 6)
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("parks at MIN_RATIO rather than collapsing a pane to nothing", () => {
    const ws = workspaceOf(["a", "b"])
    const next = resize(ws, ws.groups[0]!.id, 0, 5)
    const [a, b] = next.groups[0]!.panes
    expect(b!.ratio).toBeCloseTo(MIN_RATIO, 6)
    expect(a!.ratio).toBeCloseTo(1 - MIN_RATIO, 6)
  })

  it("ignores a divider index with no pane on its right", () => {
    const ws = workspaceOf(["a", "b"])
    expect(resize(ws, ws.groups[0]!.id, 1, 0.1)).toBe(ws)
  })
})

describe("focus", () => {
  it("stops at the ends rather than wrapping", () => {
    const ws = workspaceOf(["a", "b"])
    expect(focusedSessionId(focusAdjacent(ws, -1))).toBe("a")
    expect(focusedSessionId(focusAdjacent(focusAdjacent(ws, 1), 1))).toBe("b")
  })

  it("reports every pane of the active group as visible, not just the focused one", () => {
    const ws = workspaceOf(["a", "b"], ["c"])
    const split = activate(ws, ws.groups[0]!.id)
    expect(visibleSessionIds(split)).toEqual(new Set(["a", "b"]))
  })
})

describe("prune", () => {
  it("drops panes for sessions that no longer exist", () => {
    const ws = workspaceOf(["a", "b", "c"])
    const next = prune(ws, new Set(["a", "c"]))
    expect(paneIds(next)).toEqual(["a", "c"])
    expect(ratiosSumToOne(next)).toBe(true)
  })

  it("removes a group whose every session is gone", () => {
    const ws = workspaceOf(["a"], ["b", "c"])
    const next = prune(ws, new Set(["b", "c"]))
    expect(next.groups).toHaveLength(1)
    expect(next.activeGroupId).toBe(next.groups[0]!.id)
  })

  it("is identity when nothing is missing", () => {
    const ws = workspaceOf(["a", "b"])
    expect(prune(ws, new Set(["a", "b"]))).toBe(ws)
  })

  // The group's id comes from its first pane, so losing pane 0 re-ids it. Match
  // by position, or the active split silently becomes some other group.
  it("stays on the active group when losing its first pane re-ids it", () => {
    const built = workspaceOf(["x"], ["a", "b"])
    const ws = activate(built, built.groups[1]!.id)
    const next = prune(ws, new Set(["x", "b"]))
    expect(next.groups).toHaveLength(2)
    expect(next.activeGroupId).toBe(next.groups[1]!.id)
    expect(paneIds(next)).toEqual(["b"])
  })

  it("lands on the group that took its place when the active group dissolves", () => {
    const built = workspaceOf(["x"], ["a"], ["z"])
    const ws = activate(built, built.groups[1]!.id)
    const next = prune(ws, new Set(["x", "z"]))
    expect(next.activeGroupId).toBe(next.groups[1]!.id)
    expect(paneIds(next)).toEqual(["z"])
  })
})

describe("persistence", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a workspace", () => {
    const ws = workspaceOf(["a", "b"], ["c"])
    save(ws)
    expect(load()).toEqual(ws)
  })

  it("falls back to empty on junk rather than throwing", () => {
    localStorage.setItem("sb.split.v2", "{not json")
    expect(load()).toEqual(EMPTY_WORKSPACE)
  })

  it("drops a session named twice — two panes would share one conversation actor", () => {
    localStorage.setItem(
      "sb.split.v2",
      JSON.stringify({
        groups: [
          { id: "g:a", panes: [{ sessionId: "a", ratio: 0.5 }, { sessionId: "b", ratio: 0.5 }], focused: 0 },
          { id: "g:b", panes: [{ sessionId: "b", ratio: 1 }], focused: 0 }
        ],
        activeGroupId: "g:a"
      })
    )
    const ws = load()
    const all = ws.groups.flatMap((g) => g.panes.map((p) => p.sessionId))
    expect(all).toEqual(["a", "b"])
    expect(ws.groups).toHaveLength(1)
  })
})

describe("migrateLegacyLayout", () => {
  beforeEach(() => localStorage.clear())

  it("turns a stored 2|2 grid into one split", () => {
    const ws = migrateLegacyLayout({ mode: "2|2", slots: ["a", null, "b", "c"], focused: 2 })!
    expect(ws.groups).toHaveLength(1)
    expect(ws.groups[0]!.panes.map((p) => p.sessionId)).toEqual(["a", "b", "c"])
    // Slot 2 held "b", which is pane 1 once the null is squeezed out.
    expect(ws.groups[0]!.focused).toBe(1)
    expect(ws.groups[0]!.panes.every((p) => Math.abs(p.ratio - 1 / 3) < 1e-6)).toBe(true)
  })

  it("re-orders a legacy row-major 2x2 so panes keep their left-to-right reading", () => {
    const ws = migrateLegacyLayout({ mode: "2x2", slots: ["tl", "tr", "bl", "br"], focused: 0 })!
    expect(ws.groups[0]!.panes.map((p) => p.sessionId)).toEqual(["tl", "bl", "tr", "br"])
  })

  it("is read on boot when there is no v2 workspace yet", () => {
    localStorage.setItem("sb.layout.v1", JSON.stringify({ mode: "1|1", slots: ["a", "b"], focused: 1 }))
    const ws = load()
    expect(ws.groups).toHaveLength(1)
    expect(ws.groups[0]!.panes.map((p) => p.sessionId)).toEqual(["a", "b"])
    expect(focusedSessionId(ws)).toBe("b")
  })

  it("prefers an existing v2 workspace over the legacy grid", () => {
    localStorage.setItem("sb.layout.v1", JSON.stringify({ mode: "1", slots: ["old"], focused: 0 }))
    save(workspaceOf(["new"]))
    expect(paneIds(load())).toEqual(["new"])
  })

  it("returns null for an empty or unusable grid", () => {
    expect(migrateLegacyLayout({ mode: "1", slots: [null], focused: 0 })).toBeNull()
    expect(migrateLegacyLayout(null)).toBeNull()
    expect(migrateLegacyLayout({ mode: "1" })).toBeNull()
  })
})
