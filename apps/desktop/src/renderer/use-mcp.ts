import type { CliKind, McpServer, McpServerStatus } from "@starbase/core"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useRef } from "react"
import { rpc } from "./rpc-client.js"

/**
 * The session's MCP servers, and their live status.
 *
 * Two reads with very different costs, so they're deliberately separate:
 *
 *  - `Mcp.list` just reads the harness's config files. Cheap, so it runs on mount
 *    and gives the composer chip its count.
 *  - `Mcp.status` runs the real MCP handshake, which SPAWNS each server's command.
 *    That only ever happens because the operator asked — opening the dialog or
 *    hitting refresh — which is why the status query is `enabled: false` and driven
 *    by `refetch` rather than fetching on mount.
 *
 * Both queries are keyed on the harness as well as the session, and `cli` is passed
 * explicitly to the RPC rather than left for the main process to resolve from the
 * session store: that store is written asynchronously on a harness switch, so
 * resolving it there races the switch and can cache the old harness's servers under
 * the new harness's key forever (`staleTime: Infinity`).
 */

export const mcpServersKey = (sessionId: string, cli: CliKind) => ["mcp-servers", sessionId, cli] as const
export const mcpStatusKey = (sessionId: string, cli: CliKind) => ["mcp-status", sessionId, cli] as const

export interface McpState {
  readonly servers: ReadonlyArray<McpServer>
  readonly statuses: ReadonlyArray<McpServerStatus>
  /** A probe is in flight. */
  readonly checking: boolean
  /** When the shown statuses were gathered, or null if never probed. */
  readonly checkedAt: string | null
  /**
   * The composer chip's summary, or undefined until the list has loaded. Undefined
   * (rather than a zeroed object) so the chip can stay hidden instead of flashing
   * "0 MCP" during the first read.
   */
  readonly summary: { readonly total: number; readonly failed: number; readonly probed: boolean } | undefined
  /** Probe now. Called on dialog open and by the refresh button. */
  readonly check: (refresh: boolean) => void
}

export function useMcp(sessionId: string, cli: CliKind): McpState {
  /**
   * Whether the next refetch should bypass the main process's probe cache. A ref
   * because `refetch()` takes no arguments; it is set and then read on the same tick.
   */
  const bypassCache = useRef(false)

  const serversQuery = useQuery({
    queryKey: mcpServersKey(sessionId, cli),
    queryFn: () => rpc.mcpList(sessionId, cli),
    // Config only changes when the operator edits a file outside the app, so a
    // refetch on every window focus would be pure noise.
    staleTime: Infinity
  })

  /**
   * A real subscribing query rather than `setQueryData` into a key nothing observes:
   * an unobserved entry is inactive, so react-query garbage-collects it after the
   * default 5-minute `gcTime` and the chip's failed count and the dialog's timestamp
   * silently reset while the pane sits open. `enabled: false` keeps it manual.
   */
  const statusQuery = useQuery({
    queryKey: mcpStatusKey(sessionId, cli),
    queryFn: () => rpc.mcpStatus(sessionId, cli, bypassCache.current),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity
  })

  const { refetch } = statusQuery
  const check = useCallback(
    (refresh: boolean) => {
      bypassCache.current = refresh
      void refetch()
    },
    [refetch]
  )

  const statuses = statusQuery.data ?? []
  const servers = serversQuery.data

  const summary =
    servers === undefined
      ? undefined
      : {
          total: servers.length,
          failed: statuses.filter((s) => s.state === "failed").length,
          /**
           * Derived from the cached statuses rather than a component-local flag:
           * remounting the pane (switch session and back) would reset a `useState`
           * while the failures stayed in the query cache, so the chip would go quiet
           * about failures it had already found — the inverse of its job.
           */
          probed: statuses.length > 0
        }

  return {
    servers: servers ?? [],
    statuses,
    checking: statusQuery.isFetching,
    // Every status in a batch shares a timestamp, so the first is representative.
    checkedAt: statuses[0]?.checkedAt ?? null,
    summary,
    check
  }
}
