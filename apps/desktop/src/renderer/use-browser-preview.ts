/**
 * useBrowserPreview — dock chrome preferences (visibility + docked side) for the
 * embedded browser preview, plus the global ⌃⇧B toggle. Mirrors `useTerminalDock`
 * and persists to localStorage. The pane's live view state lives in the main
 * process (the `WebContentsView`); this only governs whether/where it shows.
 */
import { useCallback, useEffect, useState } from "react"
import type { DockSide } from "@starbase/ui"

const VISIBLE_KEY = "starbase.browser.visible"
const SIDE_KEY = "starbase.browser.side"

// Hidden by default — the browser preview is opt-in (unlike the terminal dock).
const readVisible = (): boolean => {
  try {
    return localStorage.getItem(VISIBLE_KEY) === "true"
  } catch {
    return false
  }
}

const readSide = (): DockSide => {
  try {
    return localStorage.getItem(SIDE_KEY) === "bottom" ? "bottom" : "right"
  } catch {
    return "right"
  }
}

export interface BrowserPreviewPrefs {
  visible: boolean
  toggle: () => void
  side: DockSide
  setSide: (side: DockSide) => void
}

export function useBrowserPreview(): BrowserPreviewPrefs {
  const [visible, setVisible] = useState(readVisible)
  const [side, setSideState] = useState<DockSide>(readSide)

  const toggle = useCallback(() => {
    setVisible((v) => {
      const next = !v
      try {
        localStorage.setItem(VISIBLE_KEY, String(next))
      } catch {
        /* ignore quota / privacy-mode failures */
      }
      return next
    })
  }, [])

  const setSide = useCallback((next: DockSide) => {
    setSideState(next)
    try {
      localStorage.setItem(SIDE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  // Global ⌃⇧B toggles the preview (avoids clashing with the terminal's ⌃`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === "B" || e.code === "KeyB")) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  return { visible, toggle, side, setSide }
}
