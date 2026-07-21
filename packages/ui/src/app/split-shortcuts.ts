import { MAX_PANES } from "./split-layout.js"

/**
 * What a chord ASKS for. Deliberately an intent, not an action: whether there is
 * a group to focus a pane in, or a session left to open in a new pane, is the
 * app's business — this module only reads the keyboard.
 */
export type SplitShortcut =
  | { readonly type: "new-session" }
  | { readonly type: "add-pane" }
  | { readonly type: "focus-pane"; readonly index: number }
  | { readonly type: "focus-neighbour"; readonly direction: -1 | 1 }
  | { readonly type: "move-pane"; readonly direction: -1 | 1 }
  | { readonly type: "close-pane" }

/** The half of `KeyboardEvent` this needs — so tests can pass a plain object. */
export interface Chord {
  readonly key: string
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * Physical keys for panes 1..MAX_PANES, derived from the cap so the two can
 * never drift.
 */
const PANE_CODES: ReadonlyArray<string> = Array.from(
  { length: MAX_PANES },
  (_, i) => `Digit${i + 1}`
)

/**
 * Match a keyboard chord to a split intent.
 *
 * **Shifted chords match on `code`, not `key`, and that is the whole reason this
 * function exists as its own testable unit.** `key` is the character a chord
 * PRODUCES: hold Shift on a US layout and Digit1 reports `"!"`, BracketLeft
 * reports `"{"`, Equal reports `"+"`. The first version of this map compared
 * `key` against `"1"`, `"["` and `"]"`, so `Number.parseInt(e.key, 10)` was NaN
 * and the bracket branches were unreachable — four of the six advertised
 * shortcut families were dead on arrival, and nothing caught it because nothing
 * tested the keyboard.
 *
 * `code` names the physical key and is immune to both Shift and the layout.
 * `key` is still accepted as a fallback where a layout puts these characters on
 * a different physical key than a US board does, so both routes work.
 *
 * Every chord takes `meta || ctrl`, so the same physical gesture works on macOS
 * and elsewhere.
 */
export const matchSplitShortcut = (e: Chord): SplitShortcut | null => {
  if (!(e.metaKey || e.ctrlKey)) return null

  // ⌘N / ⌃N — the one chord here that is NOT part of the split map, and the one
  // that must not fire with Shift or Alt held.
  if (!e.shiftKey && !e.altKey && (e.code === "KeyN" || e.key.toLowerCase() === "n")) {
    return { type: "new-session" }
  }
  if (!e.shiftKey) return null

  // ⌃⇧⌥← / → — move the FOCUSED pane, rather than the focus. Checked before the
  // others because it is the only branch that wants Alt; arrows are unaffected
  // by Shift, so `key` and `code` agree here.
  if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
    return { type: "move-pane", direction: e.code === "ArrowLeft" ? -1 : 1 }
  }

  // ⌃⇧= — add a pane.
  if (e.code === "Equal" || e.key === "=" || e.key === "+") return { type: "add-pane" }

  // ⌃⇧1..4 — focus pane N. The caller decides what an out-of-range pane means;
  // this only reports which one was asked for.
  const paneIndex = PANE_CODES.indexOf(e.code)
  if (paneIndex !== -1) return { type: "focus-pane", index: paneIndex }

  // ⌃⇧[ / ⌃⇧] — the pane to the left / right.
  if (e.code === "BracketLeft" || e.key === "[" || e.key === "{") {
    return { type: "focus-neighbour", direction: -1 }
  }
  if (e.code === "BracketRight" || e.key === "]" || e.key === "}") {
    return { type: "focus-neighbour", direction: 1 }
  }

  // ⌃⇧W — close the focused pane. Not a bare ⌘W: that reads as "close the
  // window", and mistaking one for the other is a far more destructive miss.
  if (e.code === "KeyW" || e.key.toLowerCase() === "w") return { type: "close-pane" }

  return null
}
