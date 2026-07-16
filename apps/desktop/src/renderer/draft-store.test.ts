import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Attachment } from "@starbase/core"
import {
  __resetDrafts,
  clearDraft,
  EMPTY_DRAFT,
  getDraft,
  seedDraftOnce,
  setDraft
} from "./draft-store.js"

/** A minimal in-memory localStorage — these tests run under the node environment. */
const fakeStorage = (opts: { failWrites?: (value: string) => boolean } = {}) => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => {
      if (opts.failWrites?.(v)) {
        const err = new Error("QuotaExceededError")
        err.name = "QuotaExceededError"
        throw err
      }
      map.set(k, v)
    }),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear()
  }
}

const install = (storage: unknown) => {
  ;(globalThis as { localStorage?: unknown }).localStorage = storage
}

const IMAGE: Attachment = { id: "att_1", name: "shot.png", mediaType: "image/png", data: "AAAA" }

beforeEach(() => {
  __resetDrafts()
  install(fakeStorage())
})

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe("draft-store", () => {
  it("returns a stable empty draft for an unknown session", () => {
    // Stability matters: useSyncExternalStore loops forever on a fresh object.
    expect(getDraft("s1")).toBe(EMPTY_DRAFT)
    expect(getDraft("s1")).toBe(getDraft("s1"))
  })

  it("keeps drafts separate per session", () => {
    setDraft("s1", { text: "hello", attachments: [] })
    setDraft("s2", { text: "world", attachments: [] })
    expect(getDraft("s1").text).toBe("hello")
    expect(getDraft("s2").text).toBe("world")
  })

  it("survives a reload — rehydrates text + attachments from storage", () => {
    setDraft("s1", { text: "half-typed", attachments: [IMAGE] })
    __resetDrafts() // simulate the app restarting; storage persists

    const restored = getDraft("s1")
    expect(restored.text).toBe("half-typed")
    expect(restored.attachments).toEqual([IMAGE])
  })

  it("clears a draft from memory and storage", () => {
    setDraft("s1", { text: "sent already", attachments: [IMAGE] })
    clearDraft("s1")
    expect(getDraft("s1")).toBe(EMPTY_DRAFT)

    __resetDrafts()
    expect(getDraft("s1")).toBe(EMPTY_DRAFT) // and it did not come back
  })

  it("degrades to text-only rather than losing the draft when the quota blows", () => {
    // Reject any write carrying an attachment — the real QuotaExceededError shape.
    const storage = fakeStorage({ failWrites: (v) => v.includes("att_1") })
    install(storage)

    setDraft("s1", { text: "keep me", attachments: [IMAGE] })

    // In memory the attachment survives (this session still has it)...
    expect(getDraft("s1").attachments).toEqual([IMAGE])

    // ...but the persisted copy dropped it to save the text.
    __resetDrafts()
    const restored = getDraft("s1")
    expect(restored.text).toBe("keep me")
    expect(restored.attachments).toEqual([])
  })

  it("does not throw when storage is unavailable entirely", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage

    expect(() => setDraft("s1", { text: "no storage", attachments: [] })).not.toThrow()
    expect(getDraft("s1").text).toBe("no storage") // memory-only, still works
    expect(() => clearDraft("s1")).not.toThrow()
  })

  it("treats an empty draft as no draft", () => {
    setDraft("s1", { text: "typing", attachments: [] })
    setDraft("s1", { text: "", attachments: [] })

    expect(getDraft("s1")).toBe(EMPTY_DRAFT)
    __resetDrafts()
    expect(getDraft("s1")).toBe(EMPTY_DRAFT) // nothing left behind in storage
  })

  describe("seedDraftOnce", () => {
    it("prefills an empty draft", () => {
      seedDraftOnce("s1", "Fix issue #42")
      expect(getDraft("s1").text).toBe("Fix issue #42")
    })

    it("never clobbers text the user already typed", () => {
      setDraft("s1", { text: "my own words", attachments: [] })
      seedDraftOnce("s1", "Fix issue #42")
      expect(getDraft("s1").text).toBe("my own words")
    })

    it("does not resurrect the prompt after it was sent", () => {
      // The send path clears the draft, but `session.initialPrompt` clears
      // asynchronously — so a re-render in that window re-offers the same seed.
      seedDraftOnce("s1", "Fix issue #42")
      clearDraft("s1")

      seedDraftOnce("s1", "Fix issue #42")
      expect(getDraft("s1")).toBe(EMPTY_DRAFT)
    })
  })

  it("tolerates garbage in storage", () => {
    const storage = fakeStorage()
    storage.map.set("sb.draft.s1", "{not json")
    install(storage)
    expect(getDraft("s1")).toBe(EMPTY_DRAFT)

    __resetDrafts()
    storage.map.set("sb.draft.s1", JSON.stringify({ text: 42 }))
    expect(getDraft("s1")).toBe(EMPTY_DRAFT)

    __resetDrafts()
    storage.map.set("sb.draft.s1", JSON.stringify({ text: "ok", attachments: "nope" }))
    expect(getDraft("s1")).toEqual({ text: "ok", attachments: [] })
  })
})
