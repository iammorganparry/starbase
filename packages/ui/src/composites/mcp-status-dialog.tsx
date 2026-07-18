import type { McpServer, McpServerStatus, McpScope } from "@starbase/core"
import { RefreshCw, Server } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { McpServerRow, mcpServerMeta, statusForServer } from "./mcp-server-row.js"
import { relativeTime } from "../lib/relative-time.js"

/**
 * "checked 2m ago". Built on the repo's existing `relativeTime` so the app speaks
 * one relative-time dialect rather than two.
 */
export const fmtChecked = (iso: string | null): string =>
  iso === null ? "not checked yet" : `checked ${relativeTime(iso)}`

const SCOPE_LABEL: Record<McpScope, string> = {
  user: "User",
  project: "Project",
  local: "This machine"
}

const SCOPE_HINT: Record<McpScope, string> = {
  user: "From your global harness config.",
  project: "Committed to this repo.",
  local: "Configured for this worktree on this machine only."
}

/** Scope order matches config precedence, so the most specific wins visually too. */
const SCOPE_ORDER: ReadonlyArray<McpScope> = ["local", "project", "user"]

/**
 * The composer's MCP status dialog: which servers this session's harness will
 * load, grouped by scope, and whether each one actually answers.
 *
 * Unlike Settings, this has a session — and therefore a worktree — so it can show
 * project and local scope alongside user scope. Probing spawns the servers' own
 * commands, so it happens when the operator opens this dialog or hits refresh,
 * never on its own.
 */
export function McpStatusDialog({
  open,
  cli,
  servers,
  statuses,
  loading = false,
  checkedAt = null,
  onRefresh,
  onClose
}: {
  open: boolean
  /** The session's harness, named in the empty state so the operator knows where to look. */
  cli: string
  servers: ReadonlyArray<McpServer>
  statuses: ReadonlyArray<McpServerStatus>
  /** A probe is in flight. */
  loading?: boolean
  /** When the shown statuses were gathered. */
  checkedAt?: string | null
  onRefresh?: () => void
  onClose?: () => void
}) {
  const failed = statuses.filter((s) => s.state === "failed").length
  const groups = SCOPE_ORDER.map((scope) => ({
    scope,
    servers: servers.filter((s) => s.scope === scope)
  })).filter((g) => g.servers.length > 0)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="w-[600px]">
        <DialogHeader>
          <Server size={16} className="text-blue" />
          <DialogTitle>MCP servers</DialogTitle>
        </DialogHeader>
        <DialogBody className="py-0">
          {servers.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              {cli} has no MCP servers configured for this session.
            </div>
          ) : (
            <>
              {failed > 0 && (
                <Callout tone="yellow">
                  {failed === 1 ? "1 server didn't respond" : `${failed} servers didn't respond`}. The
                  agent will run without {failed === 1 ? "its" : "their"} tools.
                </Callout>
              )}
              {groups.map((group) => (
                <div key={group.scope} className="border-b border-hairline py-[14px] last:border-0">
                  <div className="mb-2 flex items-baseline gap-2">
                    <span className="text-[12px] font-semibold text-text-bright">
                      {SCOPE_LABEL[group.scope]}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {SCOPE_HINT[group.scope]}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {group.servers.map((server) => {
                      const status = statusForServer(server, statuses)
                      return (
                        <McpServerRow
                          key={`${server.scope}:${server.name}`}
                          name={server.name}
                          transport={server.transport}
                          enabled={server.enabled}
                          state={status?.state}
                          meta={mcpServerMeta(server, status)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </DialogBody>
        <DialogFooter className="justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
            {loading ? "Checking servers…" : fmtChecked(checkedAt)}
          </span>
          {onRefresh && (
            <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}>
              Refresh
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
