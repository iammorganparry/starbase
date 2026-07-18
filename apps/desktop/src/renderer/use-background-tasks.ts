import { useCallback, useEffect, useRef, useState } from "react"
import type { BackgroundTask } from "@starbase/core"
import { rpc } from "./rpc-client.js"

/** How often the dock re-reads the registry. An in-memory map read over IPC. */
const POLL_MS = 2000

/**
 * A session's background tasks, kept live for the dock.
 *
 * The main process owns the state — one statechart per task, in a session-scoped
 * registry — and this hook only mirrors it. It POLLS rather than folding the
 * agent's stream events locally, for two reasons:
 *
 *  1. A background task outlives the turn that started it, and can settle when
 *     no run is streaming at all. Driving the dock off the run stream would
 *     leave a finished task showing as running until the operator sent another
 *     prompt.
 *  2. The harness's task signals are unordered and lossy by design. Folding them
 *     a second time in the renderer would be a second place to get that wrong;
 *     the registry is the single source of truth and this just reads it.
 *
 * Re-reading on mount matters for the same reason: a session opened (or
 * reopened) later has live tasks whose events were all emitted before this hook
 * existed.
 */
export const useBackgroundTasks = (sessionId: string, supported: boolean) => {
  const [tasks, setTasks] = useState<ReadonlyArray<BackgroundTask>>([])
  // Guards against a slow response landing after the session changed and
  // repopulating the dock with another session's tasks.
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId

  const refresh = useCallback(() => {
    if (!supported) return
    const forSession = sessionId
    void rpc
      .backgroundTasksList(forSession)
      .then((next) => {
        if (activeSession.current === forSession) setTasks(next)
      })
      // Best-effort: a failed read must never take down the pane the operator is
      // using. The next tick re-reads anyway.
      .catch(() => {})
  }, [sessionId, supported])

  useEffect(() => {
    if (!supported) {
      setTasks([])
      return
    }
    setTasks([])
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId, supported, refresh])

  const stop = useCallback(
    (taskId: string) => {
      // Apply the returned task immediately so the row flips to "Stopping…" on
      // the click rather than up to a poll later — the harness confirms the real
      // stop asynchronously, and a row that looks untouched invites a second click.
      void rpc
        .backgroundTasksStop(sessionId, taskId)
        .then((task) => {
          if (task) setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
        })
        .catch(() => {})
    },
    [sessionId]
  )

  const output = useCallback(
    (taskId: string) => rpc.backgroundTasksOutput(sessionId, taskId).catch(() => ""),
    [sessionId]
  )

  return { tasks, stop, output, refresh }
}
