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

/** Read a persisted draft, tolerating absent/garbage/unavailable storage. */
const read = (sessionId: string): Draft => {
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    if (!raw) return EMPTY_DRAFT
    const parsed = JSON.parse(raw) as Partial<Draft>
    // Never trust what's on disk — a shape change would otherwise crash the pane.
    if (typeof parsed?.text !== "string") return EMPTY_DRAFT
    return {
      text: parsed.text,
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : []
    }
  } catch {
    return EMPTY_DRAFT
  }
}

const write = (sessionId: string, draft: Draft): void => {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(draft))
  } catch {
    // Base64 image attachments can blow localStorage's ~5MB quota. Never lose the
    // TEXT over an image: retry without attachments. If even that fails (or
    // there's no storage at all) the in-memory copy still carries the draft
    // across session switches — only a reload would drop it.
    try {
      localStorage.setItem(storageKey(sessionId), JSON.stringify({ ...draft, attachments: [] }))
    } catch {
      /* memory-only — degraded, but the draft is still live this session */
    }
  }
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
  if (draft.text === "" && draft.attachments.length === 0) return clearDraft(sessionId)
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
  if (snapshot(sessionId).text !== "") return
  setDraft(sessionId, { text, attachments: [] })
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
}
