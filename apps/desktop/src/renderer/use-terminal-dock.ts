/**
 * useTerminalDock — dock chrome preferences (visibility + docked side) plus the
 * global ⌃` toggle. Kept SEPARATE from `useTerminals` (per-session tab state) so
 * it survives session switches and persists to localStorage. Terminals live on;
 * this only governs whether/where the dock is shown.
 */
import { useCallback, useEffect, useState } from "react"
import type { DockSide } from "@starbase/ui"

const VISIBLE_KEY = "starbase.terminal.visible"
const SIDE_KEY = "starbase.terminal.side"

const readVisible = (): boolean => {
  try {
    return localStorage.getItem(VISIBLE_KEY) === "true"
  } catch {
    return false
  }
}

const readSide = (): DockSide => {
  try {
    return localStorage.getItem(SIDE_KEY) === "right" ? "right" : "bottom"
  } catch {
    return "bottom"
  }
}

export interface TerminalDockPrefs {
  visible: boolean
  toggle: () => void
  side: DockSide
  setSide: (side: DockSide) => void
}

export function useTerminalDock(): TerminalDockPrefs {
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

  // Global ⌃` toggles the dock (VS Code's terminal shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  return { visible, toggle, side, setSide }
}
