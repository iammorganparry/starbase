/**
 * The session grid's shape and its slot assignments.
 *
 * Deliberately React-free and side-effect-free apart from the two storage
 * functions at the bottom: every rule about what a drop DOES lives here as a
 * pure reducer, so the drag-and-drop layer downstream is only plumbing. The
 * awkward cases (a session dropped onto a slot it already occupies, a mode that
 * shrinks out from under filled slots) are the ones worth having tests for, and
 * they're only cheap to test while this stays pure.
 *
 * Persistence mirrors the other renderer panel state (`sb.split.plan`,
 * `starbase.terminal.*`): localStorage, best-effort, never load-bearing.
 */

/**
 * The preset shapes, named for what they look like: `left|right`, where each
 * number is how many panes are STACKED in that column. So `2|1` is two panes on
 * the left with a full-height pane beside them.
 *
 * The operator picks the shape and the grid never re-flows on its own — a layout
 * that rearranges itself is a layout you can't build a muscle memory for.
 */
export type LayoutMode = "1" | "1|1" | "2|1" | "1|2" | "2|2"

/**
 * Rows per column. This is the whole layout model: everything else (slot count,
 * slot ordering, the rendered geometry, the picker's glyph) is derived from it,
 * so adding a shape later means adding one entry here.
 */
export const COLUMN_SPEC: Record<LayoutMode, ReadonlyArray<number>> = {
  "1": [1],
  "1|1": [1, 1],
  "2|1": [2, 1],
  "1|2": [1, 2],
  "2|2": [2, 2]
}

/**
 * Slot indices grouped by column, in render order.
 *
 * Column-major: the left column's slots come first, top to bottom, then the next
 * column. That's what makes the `2|1` notation readable as slot numbers — and it
 * means the sidebar's pane badges count down each column the way the eye does.
 */
export const columnsOf = (mode: LayoutMode): ReadonlyArray<ReadonlyArray<number>> => {
  let next = 0
  return COLUMN_SPEC[mode].map((rows) => Array.from({ length: rows }, () => next++))
}

export interface GridLayout {
  readonly mode: LayoutMode
  /** Session id per slot, `null` for an empty slot. Length always `SLOT_COUNT[mode]`. */
  readonly slots: ReadonlyArray<string | null>
  /**
   * Which slot last had the operator's attention. Not merely cosmetic: it decides
   * which pane owns the app-wide singletons (the native browser preview, the
   * terminal dock) and which session counts as "on screen" for notification
   * suppression. Always a valid index into `slots`.
   */
  readonly focused: number
}

/** Derived, never hand-maintained — the spec above is the single source. */
export const SLOT_COUNT: Record<LayoutMode, number> = Object.fromEntries(
  Object.entries(COLUMN_SPEC).map(([mode, rows]) => [mode, rows.reduce((a, b) => a + b, 0)])
) as Record<LayoutMode, number>

/** Picker order: ascending pane count, so the row reads as "more panes rightwards". */
export const LAYOUT_MODES: ReadonlyArray<LayoutMode> = ["1", "1|1", "2|1", "1|2", "2|2"]

/** Human labels for the toolbar's mode picker. */
export const LAYOUT_LABELS: Record<LayoutMode, string> = {
  "1": "Single pane",
  "1|1": "Two columns",
  "2|1": "Two left, one right",
  "1|2": "One left, two right",
  "2|2": "Four panes"
}

/** The empty 1-up layout — also the fallback whenever stored state is unusable. */
export const EMPTY_LAYOUT: GridLayout = { mode: "1", slots: [null], focused: 0 }

/**
 * The drag payload's MIME type: a session id being dragged onto the grid.
 *
 * A custom type rather than `text/plain` so the grid can tell OUR drags apart
 * from a file or a text selection dragged in from anywhere else — the composer
 * already accepts file drops, and a slot must not swallow one.
 *
 * Note that `dataTransfer.getData` returns "" during `dragover` (the spec hides
 * payload values until drop, to stop pages snooping), so a dragover handler must
 * check `types.includes(...)` rather than reading the value.
 */
export const SESSION_DND_MIME = "application/x-starbase-session-id"

const isValidSlot = (layout: GridLayout, slot: number): boolean =>
  Number.isInteger(slot) && slot >= 0 && slot < layout.slots.length

/**
 * Put `sessionId` in `slot`.
 *
 * If that session already sits in another slot, the two slots SWAP rather than
 * the session being duplicated. One session must never drive two panes: the
 * conversation actor is a single instance held in a module-level registry
 * (`conversation-registry.ts`), so two mounts would fight over one actor's
 * subscription and transcript scroll state. Swapping also happens to be what you
 * want ergonomically — dragging pane A onto pane B reads as "trade places".
 */
export const assign = (layout: GridLayout, slot: number, sessionId: string): GridLayout => {
  if (!isValidSlot(layout, slot)) return layout
  const from = layout.slots.indexOf(sessionId)
  // Already exactly where it was asked to go — a no-op, but still take focus,
  // since the operator just pointed at it.
  if (from === slot) return { ...layout, focused: slot }
  const slots = [...layout.slots]
  // Vacating `from` with whatever was in `slot` is what makes this a swap when
  // the target is occupied, and a plain move when it isn't (null goes back).
  if (from !== -1) slots[from] = layout.slots[slot] ?? null
  slots[slot] = sessionId
  return { ...layout, slots, focused: slot }
}

/** Empty a slot. Focus stays put — the slot is still there, just blank. */
export const clear = (layout: GridLayout, slot: number): GridLayout => {
  if (!isValidSlot(layout, slot)) return layout
  if (layout.slots[slot] === null) return layout
  const slots = [...layout.slots]
  slots[slot] = null
  return { ...layout, slots }
}

/**
 * Change the grid's shape, keeping the slots that still fit.
 *
 * Growing pads with empty slots. Shrinking DROPS the overflow rather than
 * compacting it into the remaining slots: the operator arranged those panes
 * deliberately, and silently relocating a session they can still see is a ruder
 * failure than removing one they asked to make room by removing. The dropped
 * sessions aren't harmed — their agents keep running in the registry, they're
 * just no longer on screen.
 */
export const setMode = (layout: GridLayout, mode: LayoutMode): GridLayout => {
  if (mode === layout.mode) return layout
  const count = SLOT_COUNT[mode]
  const slots = Array.from({ length: count }, (_, i) => layout.slots[i] ?? null)
  return { mode, slots, focused: Math.min(layout.focused, count - 1) }
}

/** Move the focus ring. Out-of-range indices are ignored rather than clamped. */
export const focus = (layout: GridLayout, slot: number): GridLayout =>
  isValidSlot(layout, slot) && slot !== layout.focused ? { ...layout, focused: slot } : layout

/** The session id in the focused slot, or null when that slot is empty. */
export const focusedSessionId = (layout: GridLayout): string | null =>
  layout.slots[layout.focused] ?? null

/**
 * Which slot each gridded session occupies — what the sidebar badges read from.
 * Slot indices are 0-based here; the badge adds one for display.
 */
export const slotIndexBySession = (layout: GridLayout): ReadonlyMap<string, number> => {
  const map = new Map<string, number>()
  layout.slots.forEach((id, i) => {
    if (id !== null) map.set(id, i)
  })
  return map
}

/**
 * Drop any slot holding a session that no longer exists.
 *
 * A layout restored from storage outlives the sessions it names — deleting a
 * session in one window, or wiping `~/starbase/sessions.json`, would otherwise
 * leave a pane pointed at an id that resolves to nothing.
 */
export const prune = (layout: GridLayout, knownIds: ReadonlySet<string>): GridLayout => {
  if (layout.slots.every((id) => id === null || knownIds.has(id))) return layout
  const slots = layout.slots.map((id) => (id !== null && knownIds.has(id) ? id : null))
  return { ...layout, slots }
}

/** The first empty slot, or -1 when the grid is full. */
export const firstEmptySlot = (layout: GridLayout): number =>
  layout.slots.findIndex((id) => id === null)

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const LAYOUT_STORAGE_KEY = "sb.layout.v1"

const isLayoutMode = (value: unknown): value is LayoutMode =>
  typeof value === "string" && (LAYOUT_MODES as ReadonlyArray<string>).includes(value)

/**
 * Modes from the first cut of this feature, before layouts became column-based.
 * A stored layout naming one is upgraded rather than thrown away — falling back
 * to 1-up would silently wipe an arrangement the operator had set up.
 *
 * `2v` (two full-width rows) has no column-based equivalent and becomes two
 * columns: same pane count, same sessions, different orientation.
 */
const LEGACY_MODES: Record<string, LayoutMode> = {
  "2h": "1|1",
  "2v": "1|1",
  "3": "2|1",
  "2x2": "2|2"
}

/**
 * Old `2x2` stored its slots row-major (TL, TR, BL, BR); the column-based model
 * is column-major (TL, BL, TR, BR). Without this the four panes of a restored
 * 2x2 would silently shuffle.
 */
const remapLegacy2x2 = (slots: ReadonlyArray<string | null>): ReadonlyArray<string | null> => [
  slots[0] ?? null,
  slots[2] ?? null,
  slots[1] ?? null,
  slots[3] ?? null
]

/**
 * Read the persisted layout, tolerating absent, malformed, or stale-shaped data.
 *
 * Never trust what's on disk: a shape change between versions must degrade to
 * 1-up, not crash the whole app shell on boot. Same defensive posture as
 * `draft-store`'s `read`.
 */
export const load = (): GridLayout => {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return EMPTY_LAYOUT
    const parsed = JSON.parse(raw) as Partial<GridLayout>
    if (!Array.isArray(parsed.slots)) return EMPTY_LAYOUT
    const rawMode: unknown = parsed?.mode
    const legacy = typeof rawMode === "string" ? LEGACY_MODES[rawMode] : undefined
    const mode = isLayoutMode(rawMode) ? rawMode : legacy
    if (mode === undefined) return EMPTY_LAYOUT
    const wasLegacy2x2 = rawMode === "2x2"
    const stored = wasLegacy2x2 ? remapLegacy2x2(parsed.slots) : parsed.slots
    const count = SLOT_COUNT[mode]
    // Rebuild the slot array to the mode's length rather than trusting the stored
    // length — the two can disagree if the mode list ever changes shape.
    // Drop duplicates as well as junk. `assign` guarantees one-session-one-slot,
    // but load() reads whatever is on disk — a hand-edited or stale store naming
    // the same session twice would mount two panes onto ONE conversation actor,
    // which then has two subtrees fighting over its subscription.
    const seen = new Set<string>()
    const slots = Array.from({ length: count }, (_, i) => {
      const id = stored[i]
      if (typeof id !== "string" || id === "" || seen.has(id)) return null
      seen.add(id)
      return id
    })
    const focused =
      typeof parsed.focused === "number" && Number.isInteger(parsed.focused)
        ? Math.min(Math.max(parsed.focused, 0), count - 1)
        : 0
    return { mode, slots, focused }
  } catch {
    return EMPTY_LAYOUT
  }
}

/** Persist the layout. Best-effort: a full or absent store is not worth an error. */
export const save = (layout: GridLayout): void => {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    /* no storage, or quota exhausted — the layout is still live in memory */
  }
}
