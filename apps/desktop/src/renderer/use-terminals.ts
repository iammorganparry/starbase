/**
 * useTerminals — per-session terminal tab state for the renderer.
 *
 * Terminals are scoped to a session (their cwd is the session's worktree). The
 * PTYs themselves live in the main process and PERSIST across session switches
 * and dock toggles, so when a session becomes active we hydrate its tab strip
 * from `Terminal.list` (rather than respawning). Tabs are only really destroyed
 * by `close` (which kills the PTY). State is keyed by session id so switching
 * away and back restores the exact tab set.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { TerminalInfo } from "@starbase/core"
import { rpc } from "./rpc-client.js"

interface SessionTerminals {
  tabs: ReadonlyArray<TerminalInfo>
  activeId: string | null
  /** True once `Terminal.list` has resolved for this session. */
  hydrated: boolean
}

type State = Record<string, SessionTerminals>

const EMPTY: SessionTerminals = { tabs: [], activeId: null, hydrated: false }

/** Union two tab lists by id, keeping `primary` order then any extras. */
const mergeById = (
  primary: ReadonlyArray<TerminalInfo>,
  extra: ReadonlyArray<TerminalInfo>
): ReadonlyArray<TerminalInfo> => {
  const seen = new Set(primary.map((t) => t.id))
  return [...primary, ...extra.filter((t) => !seen.has(t.id))]
}

export interface UseTerminals {
  tabs: ReadonlyArray<TerminalInfo>
  activeId: string | null
  /** True once this session's existing terminals have been loaded. */
  hydrated: boolean
  /** Spawn a new terminal for the active session and focus it. */
  create: () => Promise<void>
  /** Kill a terminal and drop its tab. */
  close: (id: string) => Promise<void>
  /** Focus a tab. */
  select: (id: string) => void
  /** Mark a tab exited (its shell process ended) — keeps it until closed. */
  markExited: (id: string, code: number) => void
}

export function useTerminals(sessionId: string | null, cwd?: string): UseTerminals {
  const [state, setState] = useState<State>({})
  const hydrating = useRef<Set<string>>(new Set())
  const creating = useRef(false)

  // Hydrate a session's persisted terminals once, the first time it's seen.
  useEffect(() => {
    if (!sessionId || hydrating.current.has(sessionId)) return
    hydrating.current.add(sessionId)
    let cancelled = false
    void rpc
      .terminalList(sessionId)
      .then((list) => {
        if (cancelled) return
        setState((s) => {
          const prev = s[sessionId] ?? EMPTY
          const tabs = mergeById(list, prev.tabs)
          const activeId =
            prev.activeId && tabs.some((t) => t.id === prev.activeId)
              ? prev.activeId
              : (tabs[tabs.length - 1]?.id ?? null)
          return { ...s, [sessionId]: { tabs, activeId, hydrated: true } }
        })
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, [sessionId]: { ...(s[sessionId] ?? EMPTY), hydrated: true } }))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const current = sessionId ? (state[sessionId] ?? EMPTY) : EMPTY

  const create = useCallback(async () => {
    if (!sessionId || creating.current) return
    creating.current = true
    try {
      const info = await rpc.terminalCreate(sessionId, cwd, 80, 24)
      setState((s) => {
        const prev = s[sessionId] ?? EMPTY
        return { ...s, [sessionId]: { ...prev, tabs: [...prev.tabs, info], activeId: info.id } }
      })
    } catch {
      /* spawn failed; nothing added */
    } finally {
      creating.current = false
    }
  }, [sessionId, cwd])

  const close = useCallback(
    async (id: string) => {
      if (!sessionId) return
      await rpc.terminalKill(id).catch(() => {})
      setState((s) => {
        const prev = s[sessionId]
        if (!prev) return s
        const tabs = prev.tabs.filter((t) => t.id !== id)
        const activeId = prev.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : prev.activeId
        return { ...s, [sessionId]: { ...prev, tabs, activeId } }
      })
    },
    [sessionId]
  )

  const select = useCallback(
    (id: string) => {
      if (!sessionId) return
      setState((s) => {
        const prev = s[sessionId]
        if (!prev) return s
        return { ...s, [sessionId]: { ...prev, activeId: id } }
      })
    },
    [sessionId]
  )

  const markExited = useCallback(
    (id: string, code: number) => {
      if (!sessionId) return
      setState((s) => {
        const prev = s[sessionId]
        if (!prev) return s
        return {
          ...s,
          [sessionId]: {
            ...prev,
            tabs: prev.tabs.map((t) =>
              t.id === id ? { ...t, status: "exited" as const, exitCode: code } : t
            )
          }
        }
      })
    },
    [sessionId]
  )

  return {
    tabs: current.tabs,
    activeId: current.activeId,
    hydrated: current.hydrated,
    create,
    close,
    select,
    markExited
  }
}
