import type { Session, SessionStatus } from "@starbase/core"
import { GitBranch, Layers, Plus, Search } from "lucide-react"
import { Kbd } from "../components/kbd.js"
import { Badge } from "../components/badge.js"
import { SessionRow } from "../composites/session-row.js"

export interface SessionSidebarProps {
  sessions: ReadonlyArray<Session>
  activeSessionId: string | null
  onSelect: (id: string) => void
  /** Live per-session agent status, overriding the persisted status. */
  liveStatus?: Record<string, SessionStatus>
  /** Open the New Session dialog (header "+" / ⌘N). */
  onNewSession?: () => void
  /** App version (from `__APP_VERSION__`), shown in the footer. */
  version?: string
}

/** Left rail: sessions grouped by repository, with a first-run empty hint. */
export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  liveStatus,
  onNewSession,
  version
}: SessionSidebarProps) {
  const groups = groupByRepo(sessions)

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

      {/* Groups (or the empty hint when there are no sessions yet) */}
      <div className="flex flex-1 flex-col overflow-auto px-2 pb-2 pt-0.5">
        {sessions.length === 0 ? (
          <div className="flex flex-1 flex-col px-1">
            <button
              type="button"
              onClick={onNewSession}
              className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-text-body outline-none transition-colors hover:border-blue hover:bg-surface hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus size={15} />
              New session
            </button>
            <div className="m-auto flex flex-col items-center gap-2.5 px-4 text-center">
              <Layers size={22} className="text-line-strong" />
              <span className="text-[12px] leading-[1.5] text-muted-foreground">
                No sessions yet.
                <br />
                They&apos;ll appear here as you start them.
              </span>
            </div>
          </div>
        ) : (
          groups.map(([repo, list]) => (
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
                  status={liveStatus?.[s.id]}
                  active={s.id === activeSessionId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex h-11 items-center border-t border-hairline px-4 text-[11px] text-dim">
        <span className="font-mono" title={version ? "App version" : undefined}>
          {version ? `Starbase v${version}` : "Starbase"}
        </span>
      </div>
    </div>
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
