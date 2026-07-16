/**
 * Per-session composer drafts, hoisted out of the component tree.
 *
 * The conversation pane is mounted keyed by the active session (see
 * `StarbaseApp`), so switching sessions UNMOUNTS the composer and its local
 * state — which is why a half-typed message used to vanish. That unmount is
 * load-bearing (keeping the pane mounted-but-hidden corrupts the virtualized
 * transcript's measurement cache), so the draft has to live out here instead,
 * the same way `conversation-registry` hoists the XState actor.
 *
 * Mirrors the `session-status` / `routed-store` store pattern, and persists per
 * session like `use-review`'s viewed-paths — so a draft survives a reload too.
 */
import { useSyncExternalStore } from "react"
import type { Attachment } from "@starbase/core"

export interface Draft {
  readonly text: string
  readonly attachments: ReadonlyArray<Attachment>
}

/** Shared empty snapshot — a stable reference, so `useSyncExternalStore` settles. */
export const EMPTY_DRAFT: Draft = { text: "", attachments: [] }

const storageKey = (sessionId: string): string => `sb.draft.${sessionId}`

let drafts: Record<string, Draft> = {}
const listeners = new Set<() => void>()
/** Sessions already read back from localStorage (hydration is once-per-session). */
const hydrated = new Set<string>()
/** Sessions whose one-shot prefill has been offered — see `seedDraftOnce`. */
const seeded = new Set<string>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

const isEmpty = (draft: Draft): boolean => draft.text === "" && draft.attachments.length === 0

/** Read a persisted draft, tolerating absent/garbage/unavailable storage. */
const read = (sessionId: string): Draft => {
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    if (!raw) return EMPTY_DRAFT
    const parsed = JSON.parse(raw) as Partial<Draft>
    // Never trust what's on disk — a shape change would otherwise crash the pane.
    if (typeof parsed?.text !== "string") return EMPTY_DRAFT
    const draft: Draft = {
      text: parsed.text,
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : []
    }
    // Collapse an empty record back to the shared reference, so the "no draft"
    // state has exactly one representation however it got persisted.
    return isEmpty(draft) ? EMPTY_DRAFT : draft
  } catch {
    return EMPTY_DRAFT
  }
}

const writeNow = (sessionId: string, draft: Draft): void => {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(draft))
  } catch {
    // Base64 image attachments can blow localStorage's ~5MB quota. Never lose the
    // TEXT over an image: retry without attachments. If even that fails (or
    // there's no storage at all) the in-memory copy still carries the draft
    // across session switches — only a reload would drop it.
    if (draft.text === "") return // nothing worth saving without the attachments
    try {
      localStorage.setItem(storageKey(sessionId), JSON.stringify({ ...draft, attachments: [] }))
    } catch {
      /* memory-only — degraded, but the draft is still live this session */
    }
  }
}

/**
 * How long typing must pause before the draft hits disk. Memory is updated
 * synchronously either way, so a session switch (which reads memory) never waits
 * on this — only a reload could lose the last few hundred ms of typing.
 */
const PERSIST_DEBOUNCE_MS = 400

/** The latest un-persisted draft per session, keyed by id. */
const pending = new Map<string, Draft>()
let timer: ReturnType<typeof setTimeout> | null = null

/** Write every pending draft now, and cancel the timer. */
const flushAll = (): void => {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  for (const [sessionId, draft] of pending) writeNow(sessionId, draft)
  pending.clear()
}

/**
 * Persist on a trailing debounce. `setItem` is SYNCHRONOUS and stringifying a
 * draft means stringifying its base64 attachments — doing that per keystroke is
 * a multi-MB serialize + blocking write on the app's main typing path.
 */
const write = (sessionId: string, draft: Draft): void => {
  pending.set(sessionId, draft)
  if (timer === null) timer = setTimeout(flushAll, PERSIST_DEBOUNCE_MS)
}

// Memory is always current, so a session switch never waits on the debounce —
// but a reload inside the window would drop the last keystrokes. Flush on the way
// out. `pagehide` (not `beforeunload`) is the one that fires reliably here.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAll)
}

/** The current draft, hydrating from storage on first read. Stable reference. */
const snapshot = (sessionId: string): Draft => {
  if (!hydrated.has(sessionId)) {
    hydrated.add(sessionId)
    const stored = read(sessionId)
    if (stored !== EMPTY_DRAFT) drafts = { ...drafts, [sessionId]: stored }
  }
  return drafts[sessionId] ?? EMPTY_DRAFT
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Replace a session's draft (text and/or attachments); persists + notifies. */
export const setDraft = (sessionId: string, draft: Draft): void => {
  // An empty draft IS no draft — normalising here keeps storage tidy and keeps
  // `getDraft` returning the shared EMPTY_DRAFT reference.
  if (isEmpty(draft)) return clearDraft(sessionId)
  hydrated.add(sessionId)
  drafts = { ...drafts, [sessionId]: draft }
  write(sessionId, draft)
  notify()
}

/** Drop a session's draft — on send, and when the session itself is deleted. */
export const clearDraft = (sessionId: string): void => {
  hydrated.add(sessionId)
  const { [sessionId]: _gone, ...rest } = drafts
  drafts = rest
  // Drop any debounced write first, or it would land AFTER this and resurrect
  // the draft we just cleared.
  pending.delete(sessionId)
  try {
    localStorage.removeItem(storageKey(sessionId))
  } catch {
    /* nothing persisted (or no storage) — the memory drop above is what counts */
  }
  notify()
}

/** Read a session's draft without subscribing (event handlers, one-shot seeds). */
export const getDraft = (sessionId: string): Draft => snapshot(sessionId)

/**
 * Prefill a session's draft from its linked-issue task — at most once per session,
 * ever, and never over existing text.
 *
 * Both guards matter. The session's `initialPrompt` is cleared asynchronously (on
 * send, via the backend), so without the `seeded` latch a re-render in that window
 * would resurrect the prompt the user just sent. And without the empty check, a
 * real draft could be clobbered by the seed.
 */
export const seedDraftOnce = (sessionId: string, text: string): void => {
  if (seeded.has(sessionId)) return
  seeded.add(sessionId)
  const current = snapshot(sessionId)
  if (current.text !== "") return
  // Only the TEXT is empty — carry any attachments through. A draft can hold
  // images with no words yet, and the seed must not eat them.
  setDraft(sessionId, { text, attachments: current.attachments })
}

/** A session's live draft (reactive). */
export const useDraft = (sessionId: string): Draft =>
  useSyncExternalStore(
    subscribe,
    () => snapshot(sessionId),
    () => snapshot(sessionId)
  )

/** Test-only: drop all in-memory state so suites don't leak into each other. */
export const __resetDrafts = (): void => {
  drafts = {}
  hydrated.clear()
  seeded.clear()
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  pending.clear()
}

/** Test-only: run any debounced persistence now, instead of waiting it out. */
export const __flushDrafts = (): void => flushAll()
