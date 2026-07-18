import type { ReactNode } from "react"
import type { McpServer, McpServerStatus } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Badge } from "../components/badge.js"

/**
 * Join a server to its probe status. Name alone can collide across scopes (the same
 * server can be defined at user AND project level), so both must match — shared so
 * Settings and the composer dialog can't drift on the rule.
 */
export const statusForServer = (
  server: McpServer,
  statuses: ReadonlyArray<McpServerStatus>
): McpServerStatus | undefined => statuses.find((s) => s.name === server.name && s.scope === server.scope)

/**
 * The row's mono sub-line, shared by Settings and the composer dialog so a change to
 * failure-first ordering or env-key display happens once.
 *
 * Leads with the probe outcome when there is one, since a failure reason is the most
 * useful thing on screen; otherwise shows where the server points and which
 * credentials it expects — key NAMES only, never values.
 */
export const mcpServerMeta = (
  server: McpServer,
  status?: McpServerStatus,
  opts: { readonly includeScope?: boolean } = {}
): string => {
  const parts: Array<string> = []
  if (opts.includeScope === true) parts.push(server.scope)
  if (status?.state === "connected") parts.push(`${status.toolCount ?? 0} tools`)
  else if (status?.state === "failed") parts.push(status.error ?? "failed")
  else if (status?.state === "unknown") parts.push("not checked — approve it in the harness first")
  else if (status?.state === "disabled" || !server.enabled) parts.push("not enabled")
  parts.push(server.target)
  if (server.envKeys.length > 0) parts.push(`env: ${server.envKeys.join(", ")}`)
  if (server.headerKeys.length > 0) parts.push(`headers: ${server.headerKeys.join(", ")}`)
  return parts.join(" · ")
}

/**
 * The trailing indicator.
 *
 * `enabled` and connectivity are DIFFERENT things and must not be conflated: "off"
 * means the harness won't load the server at all, whereas a server that failed its
 * probe is still loaded — the agent just runs without its tools. Rendering a failed
 * server as "off" would contradict the dialog's own warning.
 */
const indicator = (
  enabled: boolean,
  state: McpServerStatus["state"] | undefined
): { readonly tone: string; readonly label: string; readonly text: string } => {
  if (!enabled || state === "disabled") return { tone: "bg-line-strong", label: "off", text: "text-dim" }
  if (state === "failed") return { tone: "bg-red", label: "unreachable", text: "text-red" }
  if (state === "unknown") return { tone: "bg-line-strong", label: "not checked", text: "text-dim" }
  return { tone: "bg-green", label: "on", text: "text-green" }
}

/** A configured MCP server row: icon, name, transport, meta, and its on/off + health. */
export function McpServerRow({
  name,
  transport,
  meta,
  enabled = true,
  /** Probe outcome, when one exists. Drives health only — never the on/off meaning. */
  state,
  glyph = "◆",
  className
}: {
  name: string
  transport: string
  /** e.g. "6 tools · project". */
  meta?: ReactNode
  enabled?: boolean
  state?: McpServerStatus["state"]
  glyph?: ReactNode
  className?: string
}) {
  const { tone, label, text } = indicator(enabled, state)
  return (
    <div className={cn("flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-[11px] py-[9px]", className)}>
      <span className="flex size-[26px] items-center justify-center rounded-md border border-line bg-sunken text-[12px] text-text-bright">
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold text-text-bright">{name}</span>
          <Badge tone="count" size="xs">
            {transport}
          </Badge>
        </div>
        {meta && <div className="mt-0.5 font-mono text-[10px] text-dim">{meta}</div>}
      </div>
      <span className={cn("flex items-center gap-1.5 text-[10.5px]", text)}>
        <StatusDot tone={tone} size={6} glow={false} />
        {label}
      </span>
    </div>
  )
}
