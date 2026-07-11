import type { CliInfo, GhStatus, Session } from "@starbase/core"
import { GitBranch, Search } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Kbd } from "../components/kbd.js"
import { Badge } from "../components/badge.js"
import { StatusDot } from "../components/status-dot.js"
import { SessionRow } from "../composites/session-row.js"

export interface SessionSidebarProps {
  sessions: ReadonlyArray<Session>
  clis: ReadonlyArray<CliInfo>
  activeSessionId: string | null
  onSelect: (id: string) => void
  /** GitHub CLI status, shown as a chip in the harnesses strip. */
  ghStatus?: GhStatus
  /** Open the New Session dialog (header "+" / ⌘N). */
  onNewSession?: () => void
}

/** Left rail: sessions grouped by repository + a live CLI-discovery strip. */
export function SessionSidebar({
  sessions,
  clis,
  activeSessionId,
  onSelect,
  ghStatus,
  onNewSession
}: SessionSidebarProps) {
  const groups = groupByRepo(sessions)
  const totalCost = sessions.reduce((s, x) => s + x.costUsd, 0)
  const totalTokens = sessions.reduce((s, x) => s + x.tokens, 0)

  return (
    <div className="flex w-[266px] flex-none flex-col border-r border-hairline bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-5 items-center justify-center rounded-md bg-blue font-mono text-[12px] font-semibold text-editor">
            ⌘
          </span>
          <span className="text-[13px] font-semibold text-text-bright">Sessions</span>
          <Badge tone="count" size="xs">
            {sessions.length}
          </Badge>
        </div>
        <button
          type="button"
          onClick={onNewSession}
          title="New session"
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-dim outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-[15px] leading-none text-text">+</span>
          <Kbd>⌘N</Kbd>
        </button>
      </div>

      {/* Filter + group-by */}
      <div className="flex flex-col gap-2 px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-[7px] text-[12.5px] text-dim">
          <Search size={13} />
          <span className="flex-1">Filter sessions…</span>
          <Kbd>⌘K</Kbd>
        </div>
        <div className="flex items-center gap-[7px]">
          <span className="font-mono text-[9.5px] tracking-[0.4px] text-muted-foreground">GROUP BY</span>
          <span className="rounded-md border border-line bg-surface px-2.5 py-0.5 text-[11px] text-text-bright">
            Repository
          </span>
          <span className="px-1 py-0.5 text-[11px] text-dim">Status</span>
        </div>
      </div>

      {/* Groups */}
      <div className="flex flex-1 flex-col overflow-auto px-2 pb-2 pt-0.5">
        {groups.map(([repo, list]) => (
          <div key={repo}>
            <div className="flex items-center gap-[7px] px-1.5 pb-1.5 pt-2.5">
              <span className="w-2 text-center text-[9px] text-muted-foreground">▾</span>
              <GitBranch size={12} className="text-cyan" />
              <span className="flex-1 font-mono text-[11.5px] font-semibold text-text">{repo}</span>
              <Badge tone="count" size="xs">
                {list.length}
              </Badge>
            </div>
            <div className="mb-1 flex flex-col gap-[3px]">
              {list.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Discovered CLIs (live) */}
      <div className="flex flex-col gap-[7px] border-t border-hairline px-3.5 py-2.5">
        <span className="font-mono text-[9.5px] tracking-[0.4px] text-muted-foreground">HARNESSES</span>
        <div className="flex flex-wrap gap-1.5">
          {clis.length === 0 && <span className="text-[11px] text-dim">Scanning…</span>}
          {clis.map((cli) => (
            <span
              key={cli.kind}
              title={cli.available ? `${cli.binPath ?? ""}${cli.version ? ` · ${cli.version}` : ""}` : "Not installed"}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[10.5px]",
                cli.available
                  ? "border-green/30 bg-green/10 text-text"
                  : "border-line bg-white/[0.03] text-dim opacity-60"
              )}
            >
              <StatusDot tone={cli.available ? "bg-green" : "bg-line-strong"} size={6} glow={false} />
              {cli.label}
            </span>
          ))}
          {ghStatus && <GhChip gh={ghStatus} />}
        </div>
      </div>

      {/* Footer */}
      <div className="flex h-11 items-center justify-between border-t border-hairline px-4 text-[11px] text-dim">
        <span>Today</span>
        <span className="font-mono text-muted-foreground">
          ${totalCost.toFixed(2)} · {Math.round(totalTokens / 1000)}k tok
        </span>
      </div>
    </div>
  )
}

/** GitHub CLI status chip — green when authenticated, muted otherwise. */
function GhChip({ gh }: { gh: GhStatus }) {
  if (!gh.available) {
    return (
      <span
        title="gh not installed"
        className="flex items-center gap-1.5 rounded-md border border-line bg-white/[0.03] px-2 py-[3px] font-mono text-[10.5px] text-dim opacity-60"
      >
        <StatusDot tone="bg-line-strong" size={6} glow={false} />
        gh
      </span>
    )
  }
  const authed = gh.authenticated
  return (
    <span
      title={authed ? (gh.host ?? "github.com") : "Not authenticated — run `gh auth login`"}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[10.5px]",
        authed ? "border-green/30 bg-green/10 text-text" : "border-line bg-white/[0.03] text-dim"
      )}
    >
      <StatusDot tone={authed ? "bg-green" : "bg-line-strong"} size={6} glow={false} />
      {authed ? `gh · @${gh.login ?? "user"}` : "gh · signed out"}
    </span>
  )
}

function groupByRepo(sessions: ReadonlyArray<Session>): ReadonlyArray<readonly [string, ReadonlyArray<Session>]> {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    const list = map.get(s.repo) ?? []
    list.push(s)
    map.set(s.repo, list)
  }
  return [...map.entries()]
}
