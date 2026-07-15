import * as React from "react"
import type { Session, SessionStatus, User } from "@starbase/core"
import { Archive, ChevronRight, GitBranch, Layers, Plus, Search, Star } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Kbd } from "../components/kbd.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { SearchInput } from "../components/search-input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { SessionRow } from "../composites/session-row.js"
import { UserMenu } from "../composites/user-menu.js"

type GroupBy = "repo" | "status"

/**
 * Reserved key used to collapse the Archived group. It is stored alongside repo
 * paths in `collapsedRepos` (it is not a real repo path/name).
 */
export const ARCHIVED_GROUP_KEY = "__archived__"

/** Status groups render in this order (most-active first). */
const STATUS_ORDER: ReadonlyArray<SessionStatus> = [
  "needs-input",
  "thinking",
  "running",
  "idle",
  "done"
]
const STATUS_LABEL: Record<SessionStatus, string> = {
  "needs-input": "Needs input",
  thinking: "Thinking",
  running: "Running",
  idle: "Idle",
  done: "Done"
}

export interface SessionSidebarProps {
  sessions: ReadonlyArray<Session>
  activeSessionId: string | null
  onSelect: (id: string) => void
  /** Manually rename a session (double-click its title) — pins the auto-name. */
  onRename?: (id: string, title: string) => void
  /** Archive an active session from its row quick-actions (undoable via restore). */
  onArchive?: (id: string) => void
  /** Restore an archived session from its row quick-actions. */
  onRestore?: (id: string) => void
  /** Permanently delete a session from its row quick-actions (caller confirms). */
  onDelete?: (id: string) => void
  /** Live per-session agent status, overriding the persisted status. */
  liveStatus?: Record<string, SessionStatus>
  /** Open the New Session dialog (header "+" / ⌘N). */
  onNewSession?: () => void
  /** The signed-in user, shown in the footer account menu. */
  user?: User
  /** Open the Usage & limits modal (from the account menu). */
  onOpenUsage?: () => void
  /** Open the Settings view (from the account menu). */
  onOpenSettings?: () => void
  /** Sign out (from the account menu). */
  onSignOut?: () => void
  /** Whether GitHub is connected (green dot on the Settings item). */
  ghConnected?: boolean
  /** Repo names that are starred — their groups pin to the top (repo grouping). */
  starredRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's starred state from its header star button. */
  onToggleStar?: (repoName: string) => void | Promise<void>
  /**
   * Repo group keys (repo names, plus `ARCHIVED_GROUP_KEY`) that are collapsed —
   * their session lists are hidden. Only applies to repo grouping + Archived.
   */
  collapsedRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's collapsed state from its header (repo grouping + Archived). */
  onToggleCollapsed?: (repoName: string) => void | Promise<void>
  /** App version (from `__APP_VERSION__`), shown in the footer. */
  version?: string
}

/** Left rail: sessions grouped by repository, with a first-run empty hint. */
export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  liveStatus,
  onNewSession,
  user,
  onOpenUsage,
  onOpenSettings,
  onSignOut,
  ghConnected = false,
  starredRepoNames,
  onToggleStar,
  collapsedRepoNames,
  onToggleCollapsed,
  version
}: SessionSidebarProps) {
  const [filter, setFilter] = React.useState("")
  const [groupBy, setGroupBy] = React.useState<GroupBy>("repo")
  const filterRef = React.useRef<HTMLInputElement>(null)

  // ⌘K / Ctrl-K focuses the filter.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const statusOf = React.useCallback(
    (s: Session): SessionStatus => liveStatus?.[s.id] ?? s.status,
    [liveStatus]
  )

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.branch.toLowerCase().includes(q) ||
        s.repo.toLowerCase().includes(q)
    )
  }, [sessions, filter])

  // Archived sessions collapse into their own group at the bottom, regardless of
  // the active grouping; everything else is grouped by repo / status.
  const activeSessions = React.useMemo(() => filtered.filter((s) => !s.archived), [filtered])
  const archivedSessions = React.useMemo(() => filtered.filter((s) => s.archived), [filtered])
  const groups = React.useMemo(() => {
    if (groupBy === "status") return groupByStatus(activeSessions, statusOf)
    const byRepo = groupByRepo(activeSessions)
    if (!starredRepoNames || starredRepoNames.size === 0) return byRepo
    // Stable sort: starred repo groups float to the top, order otherwise kept.
    return [...byRepo].sort(
      (a, b) => Number(starredRepoNames.has(b[0])) - Number(starredRepoNames.has(a[0]))
    )
  }, [activeSessions, groupBy, statusOf, starredRepoNames])

  const archivedCollapsed = collapsedRepoNames?.has(ARCHIVED_GROUP_KEY) ?? false

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
        <SearchInput
          ref={filterRef}
          value={filter}
          onChange={setFilter}
          placeholder="Filter sessions…"
          kbd={<Kbd>⌘K</Kbd>}
        />
        <div className="flex items-center gap-[7px]">
          <span className="font-mono text-[9.5px] tracking-[0.4px] text-muted-foreground">GROUP BY</span>
          <SegmentedControl<GroupBy>
            value={groupBy}
            onChange={setGroupBy}
            items={[
              { value: "repo", label: "Repository" },
              { value: "status", label: "Status" }
            ]}
          />
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
        ) : filtered.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-2.5 px-4 text-center">
            <Search size={20} className="text-line-strong" />
            <span className="text-[12px] leading-[1.5] text-muted-foreground">
              No sessions match “{filter.trim()}”.
            </span>
          </div>
        ) : (
          <>
          {groups.map(([key, list]) => {
            // Collapse applies to repo grouping only (Status groups stay open).
            const collapsible = groupBy === "repo" && Boolean(onToggleCollapsed)
            const collapsed = collapsible && (collapsedRepoNames?.has(key) ?? false)
            return (
            <div key={key}>
              <div className="flex items-center gap-[7px] px-1.5 pb-1.5 pt-2.5">
                {collapsible ? (
                  <button
                    type="button"
                    onClick={() => onToggleCollapsed?.(key)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? "Expand repository" : "Collapse repository"}
                    className="flex min-w-0 flex-1 items-center gap-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      size={11}
                      className={cn(
                        "flex-none text-muted-foreground transition-transform",
                        !collapsed && "rotate-90"
                      )}
                    />
                    <GitBranch size={12} className="flex-none text-cyan" />
                    <span className="flex-1 truncate font-mono text-[11.5px] font-semibold text-text">
                      {key}
                    </span>
                  </button>
                ) : (
                  <>
                    <span className="w-2 text-center text-[9px] text-muted-foreground">▾</span>
                    {groupBy === "status" ? (
                      <StatusDot status={key as SessionStatus} size={8} />
                    ) : (
                      <GitBranch size={12} className="text-cyan" />
                    )}
                    <span
                      className={cn(
                        "flex-1 text-[11.5px] font-semibold text-text",
                        groupBy === "status" ? "" : "font-mono"
                      )}
                    >
                      {groupBy === "status" ? STATUS_LABEL[key as SessionStatus] : key}
                    </span>
                  </>
                )}
                {groupBy === "repo" && onToggleStar && (
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    aria-label={starredRepoNames?.has(key) ? "Unstar repository" : "Star repository"}
                    aria-pressed={starredRepoNames?.has(key) ?? false}
                    onClick={() => onToggleStar(key)}
                    className={cn(
                      "size-5 rounded hover:bg-surface",
                      starredRepoNames?.has(key) && "text-yellow hover:text-yellow"
                    )}
                  >
                    <Star size={12} className={starredRepoNames?.has(key) ? "fill-current" : undefined} />
                  </Button>
                )}
                <Badge tone="count" size="xs">
                  {list.length}
                </Badge>
              </div>
              {!collapsed && (
                <div className="mb-1 flex flex-col gap-[3px]">
                  {list.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      status={liveStatus?.[s.id]}
                      active={s.id === activeSessionId}
                      onSelect={onSelect}
                      onRename={onRename}
                      onArchive={onArchive}
                      onRestore={onRestore}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </div>
            )
          })}

          {archivedSessions.length > 0 && (
            <div>
              <div className="flex items-center gap-[7px] px-1.5 pb-1.5 pt-2.5">
                {onToggleCollapsed ? (
                  <button
                    type="button"
                    onClick={() => onToggleCollapsed(ARCHIVED_GROUP_KEY)}
                    aria-expanded={!archivedCollapsed}
                    aria-label={archivedCollapsed ? "Expand archived" : "Collapse archived"}
                    className="flex min-w-0 flex-1 items-center gap-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      size={11}
                      className={cn(
                        "flex-none text-muted-foreground transition-transform",
                        !archivedCollapsed && "rotate-90"
                      )}
                    />
                    <Archive size={12} className="flex-none text-purple" />
                    <span className="flex-1 text-[11.5px] font-semibold text-text">Archived</span>
                  </button>
                ) : (
                  <>
                    <span className="w-2 text-center text-[9px] text-muted-foreground">▾</span>
                    <Archive size={12} className="text-purple" />
                    <span className="flex-1 text-[11.5px] font-semibold text-text">Archived</span>
                  </>
                )}
                <Badge tone="count" size="xs">
                  {archivedSessions.length}
                </Badge>
              </div>
              {!archivedCollapsed && (
                <div className="mb-1 flex flex-col gap-[3px]">
                  {archivedSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === activeSessionId}
                      onSelect={onSelect}
                      onRestore={onRestore}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          </>
        )}
      </div>

      {/* Footer: account menu (name / email / avatar → Settings, Usage, Sign out). */}
      <div className="flex-none border-t border-hairline p-1.5">
        {user ? (
          <UserMenu
            user={user}
            onOpenSettings={onOpenSettings}
            onOpenUsage={onOpenUsage}
            onSignOut={onSignOut}
            ghConnected={ghConnected}
            version={version}
          />
        ) : (
          <span
            className="flex h-9 items-center px-2 font-mono text-[11px] text-dim"
            title={version ? "App version" : undefined}
          >
            {version ? `Starbase v${version}` : "Starbase"}
          </span>
        )}
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

/** Group by effective status, ordered most-active first; empty statuses omitted. */
function groupByStatus(
  sessions: ReadonlyArray<Session>,
  statusOf: (s: Session) => SessionStatus
): ReadonlyArray<readonly [string, ReadonlyArray<Session>]> {
  const map = new Map<SessionStatus, Session[]>()
  for (const s of sessions) {
    const status = statusOf(s)
    const list = map.get(status) ?? []
    list.push(s)
    map.set(status, list)
  }
  return STATUS_ORDER.filter((s) => map.has(s)).map((s) => [s, map.get(s)!] as const)
}
