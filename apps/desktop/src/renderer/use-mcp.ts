import type { CliKind, McpServer, McpServerStatus } from "@starbase/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
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
 *    hitting refresh — never automatically.
 *
 * Both queries are keyed on the harness as well as the session, because MCP config
 * is a property of the harness: switching harness mid-session re-reads declaratively
 * rather than needing an explicit invalidation.
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
  const qc = useQueryClient()
  /** Set once the operator has asked for a probe, so the chip can stop claiming green. */
  const [probed, setProbed] = useState(false)

  const serversQuery = useQuery({
    queryKey: mcpServersKey(sessionId, cli),
    queryFn: () => rpc.mcpList(sessionId),
    // Config only changes when the operator edits a file outside the app, so a
    // refetch on every focus would be pure noise.
    staleTime: Infinity
  })

  const statusMutation = useMutation({
    mutationFn: (refresh: boolean) => rpc.mcpStatus(sessionId, cli, refresh),
    onSuccess: (statuses) => {
      setProbed(true)
      qc.setQueryData(mcpStatusKey(sessionId, cli), statuses)
    }
  })

  const statuses = qc.getQueryData<ReadonlyArray<McpServerStatus>>(mcpStatusKey(sessionId, cli)) ?? []

  const check = useCallback(
    (refresh: boolean) => {
      statusMutation.mutate(refresh)
    },
    [statusMutation]
  )

  const servers = serversQuery.data
  const summary =
    servers === undefined
      ? undefined
      : {
          total: servers.length,
          failed: statuses.filter((s) => s.state === "failed").length,
          probed
        }

  return {
    servers: servers ?? [],
    statuses,
    checking: statusMutation.isPending,
    // Every status in a batch shares a timestamp, so the first is representative.
    checkedAt: statuses[0]?.checkedAt ?? null,
    summary,
    check
  }
}
