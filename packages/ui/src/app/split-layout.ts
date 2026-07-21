/**
 * The workspace's shape: sessions arranged into SPLIT GROUPS.
 *
 * This replaces the preset-slot grid (`layout-grid.ts`) with the model Arc and
 * Dia use, and the difference is not cosmetic. A split there is a *unit of
 * tabs*, not a viewport arrangement — which is exactly why their sidebar can
 * show a two-pane split as ONE row. Everything downstream falls out of that:
 *
 * - The sidebar renders one entry per group, so a split is one row by
 *   construction rather than by a special case.
 * - Closing the second-to-last pane needs no rule: a group of one IS a plain
 *   session row.
 * - "Separate all tabs" is just `one group → N groups`.
 * - There is no such thing as an empty slot, so no "Drag a session here"
 *   placeholder and no shrink-drops-the-overflow rule.
 *
 * Deliberately React-free and side-effect-free apart from the two storage
 * functions at the bottom: every rule about what a split DOES lives here as a
 * pure reducer, so the drag-and-drop layer downstream is only plumbing. The
 * awkward cases (splitting with a session that is already in another group, a
 * group that empties, ratios after a close) are the ones worth testing, and
 * they're only cheap to test while this stays pure.
 *
 * Panes are an ORDERED LIST with ratios rather than a tree. Arc also offers top
 * and bottom splits; v1 renders the list horizontally, but nothing in this
 * module says "horizontal" — adding an `axis` to `SplitGroup` later is additive,
 * not a rewrite.
 */

/** One pane: the session it shows and its share of the group's width. */
export interface Pane {
  readonly sessionId: string
  /** Share of the row, in `(0, 1)`. Ratios within a group always sum to 1. */
  readonly ratio: number
}

/**
 * A split: 1–4 sessions side by side, left to right.
 *
 * A group of ONE is not a degenerate case — it is what an ordinary,
 * un-split session is. That is the whole trick of this model.
 */
export interface SplitGroup {
  readonly id: string
  readonly panes: ReadonlyArray<Pane>
  /**
   * Index into `panes` — which pane last had the operator's attention.
   *
   * Drives the focus ring and which session the per-session terminal dock
   * follows. It does NOT decide what counts as "on screen" for notification
   * suppression: every pane of the ACTIVE group is on screen (see
   * `visibleSessionIds` in `use-split-layout`). Always a valid index.
   */
  readonly focused: number
}

/** Every group, plus which one the workspace is currently showing. */
export interface Workspace {
  readonly groups: ReadonlyArray<SplitGroup>
  /** `null` only when there are no groups at all. */
  readonly activeGroupId: string | null
}

/**
 * Arc's limit, and a sane one: past four panes on a laptop display each pane is
 * too narrow to read a transcript in. A single constant if that judgement ever
 * changes.
 */
export const MAX_PANES = 4

/** Smallest share a pane may be dragged to — below this it can't be read. */
export const MIN_RATIO = 0.15

/** The empty workspace — also the fallback whenever stored state is unusable. */
export const EMPTY_WORKSPACE: Workspace = { groups: [], activeGroupId: null }

/**
 * The drag payload's MIME type: a session id being dragged onto a pane or a
 * sidebar row.
 *
 * A custom type rather than `text/plain` so a drop target can tell OUR drags
 * apart from a file or a text selection dragged in from anywhere else — the
 * composer already accepts file drops, and a pane must not swallow one.
 *
 * Note that `dataTransfer.getData` returns "" during `dragover` (the spec hides
 * payload values until drop, to stop pages snooping), so a dragover handler must
 * check `types.includes(...)` rather than reading the value.
 */
export const SESSION_DND_MIME = "application/x-starbase-session-id"

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Group ids are derived from the leftmost pane's session rather than random.
 *
 * Two reasons: the reducers stay pure (no `crypto.randomUUID` to stub in tests,
 * no `Math.random` to make snapshots flap), and a restored workspace keeps the
 * same ids it had, so React keys and `layoutId` morphs survive a reload.
 *
 * The uniqueness this needs is only "no two groups share an id", and one session
 * lives in at most one group (see `splitWith`), so keying on the first session is
 * sufficient. Groups are re-derived whenever their first pane changes.
 */
const idFor = (panes: ReadonlyArray<Pane>): string => `g:${panes[0]?.sessionId ?? "empty"}`

/** Spread `ratio` evenly. Used whenever a group's pane count changes. */
const evenly = (sessionIds: ReadonlyArray<string>): ReadonlyArray<Pane> =>
  sessionIds.map((sessionId) => ({ sessionId, ratio: 1 / sessionIds.length }))

/**
 * Rescale ratios to sum to exactly 1 while keeping their relative sizes.
 *
 * Called after a pane is removed, where the survivors' ratios sum to less than
 * 1: a group left summing to 0.75 would render with a quarter of the row blank,
 * which reads as a rendering bug rather than as a closed pane.
 */
const renormalise = (panes: ReadonlyArray<Pane>): ReadonlyArray<Pane> => {
  if (panes.length === 0) return panes
  const total = panes.reduce((sum, p) => sum + p.ratio, 0)
  // A group whose ratios are all junk (a hand-edited store) gets equal shares
  // rather than a division by zero.
  if (!(total > 0)) return evenly(panes.map((p) => p.sessionId))
  return panes.map((p) => ({ ...p, ratio: p.ratio / total }))
}

/** Rebuild a group from a pane list, keeping focus in range and the id in sync. */
const withPanes = (group: SplitGroup, panes: ReadonlyArray<Pane>, focused: number): SplitGroup => ({
  id: idFor(panes),
  panes,
  focused: Math.min(Math.max(focused, 0), Math.max(panes.length - 1, 0))
})

const clampIndex = (n: number, length: number): number =>
  Number.isInteger(n) ? Math.min(Math.max(n, 0), length) : length

/**
 * Replace one group, dropping it entirely if it has no panes left, and keep
 * `activeGroupId` pointing at something real.
 *
 * Centralised because every reducer that shrinks a group needs the same three
 * follow-ups (drop-if-empty, re-id, re-point active), and getting one of them
 * wrong leaves the workspace showing a group that no longer exists.
 */
const replaceGroup = (ws: Workspace, groupId: string, next: SplitGroup | null): Workspace => {
  const index = ws.groups.findIndex((g) => g.id === groupId)
  if (index === -1) return ws
  const groups =
    next === null
      ? ws.groups.filter((_, i) => i !== index)
      : ws.groups.map((g, i) => (i === index ? next : g))
  const wasActive = ws.activeGroupId === groupId
  const activeGroupId = wasActive
    ? // Prefer the group that took its place in the list, then its left
      // neighbour: closing the last group in the sidebar should land on the one
      // above it, not jump to the top.
      (next?.id ?? groups[index]?.id ?? groups[index - 1]?.id ?? groups[0]?.id ?? null)
    : (ws.activeGroupId ?? groups[0]?.id ?? null)
  return { groups, activeGroupId }
}

/** Remove a session from whichever group holds it. Used before re-homing it. */
const detach = (ws: Workspace, sessionId: string): Workspace => {
  const from = ws.groups.find((g) => g.panes.some((p) => p.sessionId === sessionId))
  if (!from) return ws
  const panes = renormalise(from.panes.filter((p) => p.sessionId !== sessionId))
  const removedAt = from.panes.findIndex((p) => p.sessionId === sessionId)
  return replaceGroup(
    ws,
    from.id,
    panes.length === 0
      ? null
      : withPanes(from, panes, from.focused > removedAt ? from.focused - 1 : from.focused)
  )
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const groupById = (ws: Workspace, groupId: string): SplitGroup | null =>
  ws.groups.find((g) => g.id === groupId) ?? null

export const activeGroup = (ws: Workspace): SplitGroup | null =>
  ws.activeGroupId === null ? null : groupById(ws, ws.activeGroupId)

/** The group holding a session, or null when it isn't on screen anywhere. */
export const groupOf = (ws: Workspace, sessionId: string): SplitGroup | null =>
  ws.groups.find((g) => g.panes.some((p) => p.sessionId === sessionId)) ?? null

/** The session in the active group's focused pane — the app's "active session". */
export const focusedSessionId = (ws: Workspace): string | null => {
  const group = activeGroup(ws)
  return group?.panes[group.focused]?.sessionId ?? null
}

/** Every session the active group is showing. Empty when nothing is active. */
export const visibleSessionIds = (ws: Workspace): ReadonlySet<string> =>
  new Set(activeGroup(ws)?.panes.map((p) => p.sessionId) ?? [])

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/**
 * Show a session, the way a sidebar CLICK means it.
 *
 * Already on screen somewhere? Activate its group and focus its pane — never
 * move it. Yanking a session out of the pane it is visibly sitting in, because
 * you clicked it, is the single rudest thing this model could do. Otherwise it
 * becomes its own single-pane group, which is what "just show me this one" means
 * in Arc: the split you were looking at stays intact in the sidebar.
 */
export const show = (ws: Workspace, sessionId: string): Workspace => {
  const existing = groupOf(ws, sessionId)
  if (existing) {
    const focused = existing.panes.findIndex((p) => p.sessionId === sessionId)
    return {
      groups: ws.groups.map((g) => (g.id === existing.id ? { ...g, focused } : g)),
      activeGroupId: existing.id
    }
  }
  const group: SplitGroup = { id: idFor([{ sessionId, ratio: 1 }]), panes: evenly([sessionId]), focused: 0 }
  return { groups: [...ws.groups, group], activeGroupId: group.id }
}

/**
 * Merge `sessionId` into `groupId` at pane index `at`.
 *
 * A session already on screen is MOVED, never duplicated: the conversation actor
 * is a single instance held in a module-level registry
 * (`conversation-registry.ts`), so two panes would fight over one actor's
 * subscription and transcript scroll state. That move can dissolve the group it
 * came from, which is correct — dragging the only pane out of a split IS how you
 * end that split.
 *
 * Refuses past `MAX_PANES` rather than silently evicting a pane: the operator
 * arranged those, and dropping one they can still see to make room for a new one
 * is a worse failure than refusing the drop.
 */
export const splitWith = (
  ws: Workspace,
  groupId: string,
  sessionId: string,
  at: number
): Workspace => {
  const target = groupById(ws, groupId)
  if (!target) return ws
  const alreadyHere = target.panes.findIndex((p) => p.sessionId === sessionId)
  // Dropping a session onto the split it is already part of is a no-op, not a
  // reorder — the drop zones express "put it beside this one", and it already is.
  if (alreadyHere !== -1) {
    return { ...ws, activeGroupId: target.id, groups: ws.groups.map((g) => (g.id === target.id ? { ...g, focused: alreadyHere } : g)) }
  }
  if (target.panes.length >= MAX_PANES) return ws
  // Detach FIRST, then re-read the target: pulling the session out of another
  // group can renumber or drop groups, and inserting into a stale copy would
  // resurrect the group we just emptied.
  const detached = detach(ws, sessionId)
  const fresh = groupById(detached, groupId)
  if (!fresh) return ws
  const index = clampIndex(at, fresh.panes.length)
  const ids = fresh.panes.map((p) => p.sessionId)
  const nextIds = [...ids.slice(0, index), sessionId, ...ids.slice(index)]
  return {
    ...replaceGroup(detached, groupId, withPanes(fresh, evenly(nextIds), index)),
    activeGroupId: idFor(evenly(nextIds))
  }
}

/**
 * Swap the session shown in one pane for another — what a drop onto a pane's
 * MIDDLE means.
 *
 * One reducer rather than `closePane` + `splitWith` from the caller, because a
 * group's id is derived from its leftmost pane (`idFor`): closing pane 0 re-ids
 * the group, so a follow-up call holding the id from before the close finds
 * nothing and silently drops the session. Atomic here, and the id can only
 * change once.
 *
 * Like `splitWith`, the incoming session is MOVED, never duplicated — including
 * when it is already a pane of THIS group, in which case the group shrinks by
 * one (its old pane goes away, the replaced pane becomes it).
 */
export const replacePane = (
  ws: Workspace,
  groupId: string,
  index: number,
  sessionId: string
): Workspace => {
  const group = groupById(ws, groupId)
  if (!group || index < 0 || index >= group.panes.length) return ws
  if (group.panes[index]!.sessionId === sessionId) return activate(ws, groupId)
  // Pull the session out of any OTHER group first. That can dissolve the group
  // it came from but never touches this one, so `groupId` is still valid after.
  const elsewhere = groupOf(ws, sessionId)
  const base = elsewhere && elsewhere.id !== groupId ? detach(ws, sessionId) : ws
  const target = groupById(base, groupId)
  if (!target) return ws
  // A duplicate inside this same group is dropped rather than detached, so the
  // widths of the panes that survive are preserved rather than reset to even.
  const duplicate = target.panes.findIndex((p) => p.sessionId === sessionId)
  const kept = target.panes.filter((_, i) => i === index || i !== duplicate)
  const at = duplicate !== -1 && duplicate < index ? index - 1 : index
  const panes = renormalise(kept.map((p, i) => (i === at ? { ...p, sessionId } : p)))
  return {
    ...replaceGroup(base, groupId, withPanes(target, panes, at)),
    // The pane you just dropped onto is the one you're looking at.
    activeGroupId: idFor(panes)
  }
}

/**
 * Remove a pane. The session keeps running — this only stops SHOWING it.
 *
 * A group that drops to zero panes is removed entirely; a group that drops to
 * one is just an ordinary session row, with no transition to perform.
 */
export const closePane = (ws: Workspace, groupId: string, index: number): Workspace => {
  const group = groupById(ws, groupId)
  if (!group || index < 0 || index >= group.panes.length) return ws
  const panes = renormalise(group.panes.filter((_, i) => i !== index))
  if (panes.length === 0) return replaceGroup(ws, groupId, null)
  // Focus holds its PLACE IN THE ROW, not its pane.
  //
  // Closing the focused pane leaves focus on whichever pane slides into the slot
  // it vacated — its RIGHT neighbour — and only falls to the left when the
  // closed pane was the last one, where nothing slides in and the slot itself
  // ceases to exist. So the eye stays where it already was rather than being
  // sent somewhere by the close.
  //
  // (An earlier comment here claimed the left neighbour throughout, "matching
  // how closing a tab anywhere else behaves". Both halves were wrong: the code
  // has always done the above, and Chrome, Safari and Firefox all activate the
  // tab to the RIGHT when you close the active one. Every position is pinned in
  // the tests now, so the claim and the behaviour can't drift apart again.)
  //
  // Closing an UNFOCUSED pane keeps the same session focused either way, which
  // is the `> index` branch shifting the index down to follow it.
  const focused = group.focused > index ? group.focused - 1 : Math.min(group.focused, panes.length - 1)
  return replaceGroup(ws, groupId, withPanes(group, panes, focused))
}

/** Move a pane one place left or right within its group. Ends are no-ops. */
export const movePane = (
  ws: Workspace,
  groupId: string,
  index: number,
  direction: -1 | 1
): Workspace => {
  const group = groupById(ws, groupId)
  if (!group) return ws
  const to = index + direction
  if (index < 0 || index >= group.panes.length || to < 0 || to >= group.panes.length) return ws
  const panes = [...group.panes]
  const [moved] = panes.splice(index, 1)
  panes.splice(to, 0, moved!)
  // Focus follows the pane the operator just moved, not the index it left.
  return replaceGroup(ws, groupId, withPanes(group, panes, to))
}

/**
 * Arc's "Separate All Tabs": explode a group into one single-pane group per
 * session, left-to-right order preserved, in place in the sidebar list.
 */
export const separateAll = (ws: Workspace, groupId: string): Workspace => {
  const group = groupById(ws, groupId)
  if (!group || group.panes.length < 2) return ws
  const singles: ReadonlyArray<SplitGroup> = group.panes.map((p) => ({
    id: idFor([p]),
    panes: evenly([p.sessionId]),
    focused: 0
  }))
  const index = ws.groups.findIndex((g) => g.id === groupId)
  const groups = [...ws.groups.slice(0, index), ...singles, ...ws.groups.slice(index + 1)]
  // The pane that had focus stays the one you're looking at, now on its own.
  const active = singles[group.focused] ?? singles[0]!
  return { groups, activeGroupId: ws.activeGroupId === groupId ? active.id : ws.activeGroupId }
}

/**
 * Drag the divider after pane `index` by `delta` (a fraction of the row's
 * width), moving ONLY the two panes it sits between.
 *
 * Rippling the change through every pane would mean grabbing one divider
 * silently resizes panes on the other side of the row, which is not what a
 * divider means anywhere else. Both neighbours are clamped to `MIN_RATIO`, so a
 * hard drag parks the divider rather than collapsing a pane to nothing.
 */
export const resize = (
  ws: Workspace,
  groupId: string,
  index: number,
  delta: number
): Workspace => {
  const group = groupById(ws, groupId)
  if (!group) return ws
  const left = group.panes[index]
  const right = group.panes[index + 1]
  if (!left || !right || !Number.isFinite(delta)) return ws
  const pair = left.ratio + right.ratio
  // Below this there is no split of the pair that leaves BOTH panes at least
  // `MIN_RATIO`, and the clamp bounds below cross — the upper drops under the
  // lower, and the result comes out negative, which is not a width any browser
  // will honour. Only a corrupt store can get a pair this small (`load` rejects
  // such ratios, and every reducer here preserves the minimum), so refusing is
  // the honest answer: there is no legal position to move the divider to.
  if (pair < MIN_RATIO * 2) return ws
  // Clamp against the PAIR's budget, not against 1: the two panes can only ever
  // trade with each other, so `left` may not grow past `pair - MIN_RATIO`.
  const nextLeft = Math.min(Math.max(left.ratio + delta, MIN_RATIO), pair - MIN_RATIO)
  if (nextLeft === left.ratio) return ws
  const panes = group.panes.map((p, i) =>
    i === index ? { ...p, ratio: nextLeft } : i === index + 1 ? { ...p, ratio: pair - nextLeft } : p
  )
  return replaceGroup(ws, groupId, { ...group, panes })
}

/** Make a group the one on screen. Unknown ids are ignored rather than clearing. */
export const activate = (ws: Workspace, groupId: string): Workspace =>
  groupById(ws, groupId) === null || ws.activeGroupId === groupId
    ? ws
    : { ...ws, activeGroupId: groupId }

/** Move the focus ring within a group (and make that group active). */
export const focusPane = (ws: Workspace, groupId: string, index: number): Workspace => {
  const group = groupById(ws, groupId)
  if (!group || index < 0 || index >= group.panes.length) return ws
  return {
    groups: ws.groups.map((g) => (g.id === groupId ? { ...g, focused: index } : g)),
    activeGroupId: groupId
  }
}

/**
 * Move focus to the adjacent pane of the active group. Stops at the ends rather
 * than wrapping: wrapping turns "next pane" into a guess about where you'll land.
 */
export const focusAdjacent = (ws: Workspace, direction: -1 | 1): Workspace => {
  const group = activeGroup(ws)
  if (!group) return ws
  const next = group.focused + direction
  return next < 0 || next >= group.panes.length ? ws : focusPane(ws, group.id, next)
}

/**
 * Drop every pane naming a session that no longer exists.
 *
 * A workspace restored from storage outlives the sessions it names — deleting a
 * session in one window, or wiping `~/starbase/sessions.json`, would otherwise
 * leave a pane pointed at an id that resolves to nothing.
 */
export const prune = (ws: Workspace, knownIds: ReadonlySet<string>): Workspace => {
  if (ws.groups.every((g) => g.panes.every((p) => knownIds.has(p.sessionId)))) return ws
  const groups: Array<SplitGroup> = []
  // A group's id is derived from its first pane, so losing pane 0 re-ids the
  // group. Track the active one by position rather than by id, or the operator
  // watching [a|b] gets yanked to an unrelated group the moment `a` goes.
  let activeId: string | null = null
  let activeAt = -1
  for (const group of ws.groups) {
    const wasActive = group.id === ws.activeGroupId
    const kept = group.panes.filter((p) => knownIds.has(p.sessionId))
    if (kept.length === 0) {
      // Dissolved entirely: remember where it sat so the fallback can land next
      // to it rather than at the top of the sidebar.
      if (wasActive) activeAt = groups.length
      continue
    }
    const removedBefore = group.panes.filter((p, i) => i < group.focused && !knownIds.has(p.sessionId)).length
    const next = withPanes(group, renormalise(kept), group.focused - removedBefore)
    if (wasActive) {
      activeId = next.id
      activeAt = groups.length
    }
    groups.push(next)
  }
  const activeGroupId =
    activeId ??
    // Same landing order as `replaceGroup`: whatever took its place, then its
    // neighbour above, then the top.
    (activeAt === -1 ? (groups[0]?.id ?? null) : (groups[activeAt]?.id ?? groups[activeAt - 1]?.id ?? groups[0]?.id ?? null))
  return { groups, activeGroupId }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const WORKSPACE_STORAGE_KEY = "sb.split.v2"
/** The preset-grid key this model replaces. Read once, to migrate, then ignored. */
export const LEGACY_LAYOUT_STORAGE_KEY = "sb.layout.v1"

/**
 * Rows per column for the legacy preset modes, needed only to read a stored
 * layout in the order the operator SAW it.
 *
 * The old model stored slots column-major (left column top-to-bottom, then the
 * next), so reading `slots` in index order already yields left-to-right,
 * top-to-bottom — which is the closest thing to a horizontal pane order. The one
 * legacy mode that stored differently (`2x2`, row-major) is remapped below.
 */
const LEGACY_ROW_MAJOR_MODES = new Set(["2x2"])

const remapLegacy2x2 = (slots: ReadonlyArray<string | null>): ReadonlyArray<string | null> => [
  slots[0] ?? null,
  slots[2] ?? null,
  slots[1] ?? null,
  slots[3] ?? null
]

/**
 * Upgrade a stored preset grid into a single split.
 *
 * The operator had those sessions side by side on purpose, so they stay side by
 * side — as one group, which is the only thing this model can mean by "all of
 * these on screen at once". Overflow past `MAX_PANES` is dropped rather than
 * spilled into extra groups: an old `2|2` holds at most four, so in practice
 * this never truncates.
 */
export const migrateLegacyLayout = (raw: unknown): Workspace | null => {
  if (typeof raw !== "object" || raw === null) return null
  const parsed = raw as { mode?: unknown; slots?: unknown; focused?: unknown }
  if (!Array.isArray(parsed.slots)) return null
  const stored = LEGACY_ROW_MAJOR_MODES.has(String(parsed.mode))
    ? remapLegacy2x2(parsed.slots as ReadonlyArray<string | null>)
    : (parsed.slots as ReadonlyArray<string | null>)
  // Which SLOT had focus maps to which PANE has focus only after the nulls are
  // squeezed out, so count the survivors to its left rather than reusing the index.
  const focusedSlot = typeof parsed.focused === "number" ? parsed.focused : 0
  const seen = new Set<string>()
  const ids: Array<string> = []
  let focused = 0
  stored.forEach((id, i) => {
    if (typeof id !== "string" || id === "" || seen.has(id) || ids.length >= MAX_PANES) return
    if (i <= focusedSlot) focused = ids.length
    seen.add(id)
    ids.push(id)
  })
  if (ids.length === 0) return null
  const panes = evenly(ids)
  return { groups: [{ id: idFor(panes), panes, focused }], activeGroupId: idFor(panes) }
}

/**
 * Slack for float drift, so a legitimately-saved `MIN_RATIO` that came back as
 * 0.1499999 isn't mistaken for a corrupt one and thrown away.
 */
const RATIO_EPSILON = 1e-6

/**
 * Stored ratios, or equal shares when the stored ones cannot be honoured.
 *
 * `renormalise` only makes the ratios SUM to one; it says nothing about any
 * individual pane, so a hand-edited store can name a group whose two adjacent
 * panes share less than `MIN_RATIO` between them. `resize` clamps the dragged
 * pair to `[MIN_RATIO, pair - MIN_RATIO]`, and those bounds CROSS once the pair
 * is small enough — the upper falls below the lower and the result comes out
 * negative, which is not a width any browser will honour.
 *
 * Rejecting the whole group's proportions rather than clamping pane by pane is
 * deliberate: clamping one pane up forces the renormalise that follows to push
 * another back down, so the rule would need to iterate to a fixed point to be
 * correct. Equal shares always satisfy the minimum (`MAX_PANES * MIN_RATIO` is
 * under 1 by construction) and are what a fresh split would have used anyway.
 */
const restoreRatios = (panes: ReadonlyArray<Pane>): ReadonlyArray<Pane> => {
  const normalised = renormalise(panes)
  return normalised.every((p) => p.ratio >= MIN_RATIO - RATIO_EPSILON)
    ? normalised
    : evenly(normalised.map((p) => p.sessionId))
}

const isPane = (value: unknown): value is Pane =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Pane).sessionId === "string" &&
  (value as Pane).sessionId !== "" &&
  typeof (value as Pane).ratio === "number" &&
  Number.isFinite((value as Pane).ratio)

/**
 * Read the persisted workspace, tolerating absent, malformed or stale-shaped
 * data, and migrating a v1 grid when there is no v2 to read.
 *
 * Never trust what's on disk: a shape change between versions must degrade to an
 * empty workspace, not crash the whole app shell on boot. Same defensive posture
 * as `draft-store`'s `read`.
 */
export const load = (): Workspace => {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY)
      if (legacy === null) return EMPTY_WORKSPACE
      return migrateLegacyLayout(JSON.parse(legacy) as unknown) ?? EMPTY_WORKSPACE
    }
    const parsed = JSON.parse(raw) as Partial<Workspace>
    if (!Array.isArray(parsed.groups)) return EMPTY_WORKSPACE
    // Drop duplicates ACROSS groups as well as junk. The reducers guarantee
    // one-session-one-pane, but `load` reads whatever is on disk — a hand-edited
    // or stale store naming the same session twice would mount two panes onto ONE
    // conversation actor, which then has two subtrees fighting over its
    // subscription.
    const seen = new Set<string>()
    const groups: Array<SplitGroup> = []
    for (const g of parsed.groups) {
      if (typeof g !== "object" || g === null || !Array.isArray(g.panes)) continue
      // Cap and record in LOCKSTEP. Filtering first and slicing after left the
      // dropped overflow in `seen`, so a stale store with a five-pane group
      // burned its fifth session's id: a LATER group naming that session skipped
      // it too, and it vanished from the workspace entirely rather than being
      // kept by the group that still had room for it.
      const panes: Array<Pane> = []
      for (const p of g.panes as ReadonlyArray<unknown>) {
        if (panes.length >= MAX_PANES) break
        if (!isPane(p) || seen.has(p.sessionId)) continue
        seen.add(p.sessionId)
        panes.push(p)
      }
      if (panes.length === 0) continue
      const focused = typeof g.focused === "number" && Number.isInteger(g.focused) ? g.focused : 0
      groups.push(withPanes({ id: "", panes, focused: 0 }, restoreRatios(panes), focused))
    }
    if (groups.length === 0) return EMPTY_WORKSPACE
    const activeGroupId =
      typeof parsed.activeGroupId === "string" && groups.some((g) => g.id === parsed.activeGroupId)
        ? parsed.activeGroupId
        : groups[0]!.id
    return { groups, activeGroupId }
  } catch {
    return EMPTY_WORKSPACE
  }
}

/** Persist the workspace. Best-effort: a full or absent store is not an error. */
export const save = (ws: Workspace): void => {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws))
  } catch {
    /* no storage, or quota exhausted — the workspace is still live in memory */
  }
}
