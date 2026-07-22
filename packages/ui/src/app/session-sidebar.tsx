import * as React from "react"
import type { SessionPrStatus, Session, SessionActivity, SessionDisplayStatus, User } from "@starbase/core"
import { displayStatusOf, UNTITLED_SESSION } from "@starbase/core"
import {
  ChevronRight,
  Columns2,
  GitBranch,
  Layers,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  Star
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { ResizeHandle, useResizableWidth } from "../components/resizable.js"
import { Kbd } from "../components/kbd.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { SearchInput } from "../components/search-input.js"
import { FilterMenu } from "../components/filter-menu.js"
import { HoverCard } from "../components/hover-card.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { SessionRow } from "../composites/session-row.js"
import { SessionHoverCard } from "../composites/session-hover-card.js"
import { SplitRow } from "../composites/split-row.js"
import { displayStatusLabel, displayStatusTone } from "../tokens.js"
import { UserMenu } from "../composites/user-menu.js"
import type { SplitGroup } from "./split-layout.js"
import {
  filterSessions,
  groupSessions,
  isNarrowed,
  loadFilters,
  reconcileRepo,
  saveFilters,
  sessionFilterAxes,
  type SessionFilters
} from "./session-filters.js"

export interface SessionSidebarProps {
  sessions: ReadonlyArray<Session>
  activeSessionId: string | null
  /**
   * Which pane each on-screen session occupies, for the numbered badges. Absent
   * when the split isn't wired (stories) — rows then show no badge.
   */
  slotBySession?: ReadonlyMap<string, number>
  /**
   * The splits, so a multi-pane group renders as ONE row (Arc's pill) rather than
   * as N unrelated rows. Groups of one aren't listed here — a one-pane group and
   * a plain session are the same object, and the caller renders it as a
   * `SessionRow` either way.
   */
  splitGroups?: ReadonlyArray<SplitGroup>
  /** Which group is on screen (highlights its pill). */
  activeGroupId?: string | null
  /** Focus one pane of a split from its sidebar segment. */
  onFocusPane?: (groupId: string, index: number) => void
  /** Close one pane from its segment's × (the session keeps running). */
  onClosePane?: (groupId: string, index: number) => void
  /** Arc's "Separate all tabs" — every pane flies out to its own row. */
  onSeparateAll?: (groupId: string) => void
  /** A session was dropped on a pill, or picked from its "Split with ▸" submenu. */
  onSplitWith?: (groupId: string, sessionId: string, at: number) => void
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
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live linked-PR state per session id, badged onto the row (never auto-archives). */
  prStates?: Record<string, SessionPrStatus>
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
   * Repo names whose groups are collapsed — their session lists are hidden.
   * Only applies while Group by is Repository.
   */
  collapsedRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's collapsed state from its header. */
  onToggleCollapsed?: (repoName: string) => void | Promise<void>
  /** App version (from `__APP_VERSION__`), shown in the footer. */
  version?: string
  /**
   * Open on these filters instead of the persisted ones.
   *
   * For stories and tests, which need a deterministic view and cannot reach the
   * menu (Radix portals its flyouts and needs a real pointer to open one). Not
   * used by the app — there, the persisted set IS the right starting point.
   */
  defaultFilters?: SessionFilters
}

/** Left rail: sessions grouped by repository, with a first-run empty hint. */
/**
 * The sidebar's full contents.
 *
 * Rendered by `SessionSidebar` below either docked in the layout or floating in
 * the hover overlay — the same markup both times, so the expanded rail can't
 * drift out of sync with the docked sidebar it is meant to be.
 */
function SidebarBody({
  width,
  onResize,
  sessions,
  activeSessionId,
  slotBySession,
  splitGroups,
  activeGroupId,
  onFocusPane,
  onClosePane,
  onSeparateAll,
  onSplitWith,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  liveActivity,
  prStates,
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
  version,
  defaultFilters,
  onCollapse
}: SessionSidebarProps & {
  /** Current docked width in px. */
  width: number
  /** Drag deltas from the edge handle. */
  onResize?: (deltaX: number) => void
  /** Collapse to the icon rail (the header's `PanelLeft` button). */
  onCollapse?: () => void
}) {
  const [filter, setFilter] = React.useState("")
  const [filters, setFiltersState] = React.useState<SessionFilters>(
    () => defaultFilters ?? loadFilters()
  )
  const filterRef = React.useRef<HTMLInputElement>(null)

  const setFilters = React.useCallback((next: SessionFilters) => {
    setFiltersState(next)
    saveFilters(next)
  }, [])

  // A persisted repo filter outlives the sessions that justified it. Left alone
  // it would empty the sidebar with no visible cause — the filter naming the
  // missing repo isn't in the menu either, because the menu is built from the
  // repos that exist.
  React.useEffect(() => {
    const reconciled = reconcileRepo(filters, sessions)
    if (reconciled !== filters) setFilters(reconciled)
  }, [filters, sessions, setFilters])

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

  // The GROUP a session sits in. The row's own five-word rollup, with ONE further
  // fold: thinking → running. An agent flips between thinking and running every
  // few seconds as tools start and stop, so grouping on that distinction would
  // reorder the list under the reader's cursor. The row still says which.
  const statusOf = React.useCallback(
    (s: Session): SessionDisplayStatus => {
      const display = displayStatusOf(liveActivity?.[s.id], s.status)
      return display === "thinking" ? "running" : display
    },
    [liveActivity]
  )

  const filtered = React.useMemo(
    () => filterSessions(sessions, filter, filters),
    [sessions, filter, filters]
  )

  /**
   * Sessions that sit inside a SPLIT of two panes or more.
   *
   * Groups of one are deliberately absent: they render as ordinary rows, which
   * is the whole point of the model — a lone pane and a lone session are
   * indistinguishable.
   */
  const splitMemberIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const g of splitGroups ?? []) {
      if (g.panes.length < 2) continue
      for (const p of g.panes) ids.add(p.sessionId)
    }
    return ids
  }, [splitGroups])

  // Sessions that belong to a SPLIT (two panes or more) are held out of the
  // grouped lists entirely — they are drawn once, above, in the splits section.
  // Held out BEFORE grouping rather than skipped during render, so a group's
  // count badge matches the rows under it and a repo whose every session is in
  // a split disappears instead of rendering an empty heading.
  const groups = React.useMemo(
    () =>
      groupSessions(
        filtered.filter((s) => !splitMemberIds.has(s.id)),
        filters,
        statusOf,
        starredRepoNames
      ),
    [filtered, splitMemberIds, filters, statusOf, starredRepoNames]
  )

  // Counts for the Status flyout, computed over the SEARCH-narrowed list rather
  // than the whole store: while you're typing, "Archived 3" should mean three
  // matches, not three in existence.
  const searched = React.useMemo(
    () => filterSessions(sessions, filter, { ...filters, status: "all", repo: null }),
    [sessions, filter, filters]
  )

  const axes = React.useMemo(
    () => sessionFilterAxes(filters, setFilters, searched),
    [filters, setFilters, searched]
  )

  const narrowed = isNarrowed(filters)

  /**
   * The splits worth drawing, in workspace order.
   *
   * A split used to be drawn INSIDE whichever repo group its first surviving
   * pane happened to sit in. That stopped making sense the moment a split could
   * span two repos: the pill claimed one repo as its home, and the other repo's
   * session had no entry of its own to show. Splits now sit above the groups
   * entirely, so a split belongs to no repo — which is the truth.
   *
   * Kept only while at least one pane survives the current search/filters: a
   * split none of whose sessions match should no more appear than a session that
   * doesn't match. ONE surviving pane is enough — the pill names every member,
   * so hiding it because pane 1 didn't match would lose pane 2's only entry.
   */
  const visibleSplits = React.useMemo(() => {
    const rendered = new Set(filtered.map((s) => s.id))
    return (splitGroups ?? []).filter(
      (g) => g.panes.length >= 2 && g.panes.some((p) => rendered.has(p.sessionId))
    )
  }, [splitGroups, filtered])

  const renderSplit = (split: SplitGroup) => (
    <SplitRow
      key={split.id}
      group={split}
      sessions={sessions}
      liveActivity={liveActivity}
      active={split.id === activeGroupId}
      onFocusPane={onFocusPane}
      onClosePane={onClosePane}
      onSeparateAll={onSeparateAll}
      onSplitWith={onSplitWith}
      splitCandidates={sessions.filter(
        (c) => !c.archived && !split.panes.some((p) => p.sessionId === c.id)
      )}
    />
  )

  /**
   * One row in a grouped list.
   *
   * Split members never reach here — they are held out of `groups` before
   * grouping, so a session cannot appear both in a pill and as a loose row.
   */
  const renderEntry = (s: Session) => {
    return (
      <SessionRow
        key={s.id}
        session={s}
        activity={liveActivity?.[s.id]}
        prState={prStates?.[s.id]}
        active={s.id === activeSessionId}
        slotIndex={slotBySession?.get(s.id) ?? null}
        onSelect={onSelect}
        onRename={onRename}
        onArchive={onArchive}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    )
  }

  return (
    <div
      style={{ width }}
      data-testid="session-sidebar"
      className="relative flex flex-none flex-col border-r border-hairline bg-panel"
    >
      {/* The width was a hard `w-[266px]` with no way to change it — the only
          fixed column in the app that couldn't be dragged. */}
      {onResize && (
        <ResizeHandle
          onResize={onResize}
          aria-label="Resize sidebar"
          className="absolute inset-y-0 right-0"
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between gap-1.5 px-3 pb-2 pt-4">
        <div className="flex min-w-0 items-center gap-2">
          {/* The rail's expand button lives in the same corner, so the control
              that changes this state is in one place rather than two. */}
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse sidebar"
              title="Collapse sidebar (⌘B)"
              className="flex size-6 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelLeft size={14} />
            </button>
          )}
          <span className="flex size-5 flex-none items-center justify-center rounded-md bg-blue font-mono text-[12px] font-semibold text-editor">
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

      {/*
        Search + the filter menu, on ONE row.

        This replaced a second row holding a "GROUP BY [Repository|Status]"
        segmented control. Two axes already cost a permanent row above the list
        they filter; the four axes this now offers would have cost more vertical
        space than the first three sessions. The menu folds them into a 24px
        button that still reports each axis's current value on its own row, so
        nothing is hidden — only folded.
      */}
      <div className="flex items-center gap-1.5 px-3 pb-2">
        <div className="min-w-0 flex-1">
          <SearchInput
            ref={filterRef}
            value={filter}
            onChange={setFilter}
            placeholder="Filter sessions…"
            kbd={<Kbd>⌘K</Kbd>}
          />
        </div>
        <FilterMenu axes={axes}>
          <button
            type="button"
            aria-label="Filter and sort sessions"
            title="Filter and sort sessions"
            data-testid="session-filter-menu"
            className={cn(
              "relative flex size-7 flex-none items-center justify-center rounded-md outline-none transition-colors",
              "hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
              narrowed ? "text-blue" : "text-dim hover:text-text"
            )}
          >
            <SlidersHorizontal size={14} />
            {/* A dot, because the button's own colour is easy to miss and a
                narrowed list looks exactly like a short one. Only NARROWING
                earns it — grouping and sorting rearrange what's there rather
                than hiding any of it. */}
            {narrowed && (
              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-blue" />
            )}
          </button>
        </FilterMenu>
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
          {/* Splits, above every group and directly under the filters.
              A split can span repos, so nesting it under one repo's heading
              named an owner it doesn't have. Its own section says the true
              thing: these are on screen together, wherever they came from. */}
          {visibleSplits.length > 0 && (
            <div>
              <div className="flex items-center gap-[7px] px-1.5 pb-1.5 pt-2.5">
                <span className="w-2 text-center text-[9px] text-muted-foreground">▾</span>
                <Columns2 size={12} className="text-blue" />
                <span className="flex-1 truncate text-[11.5px] font-semibold text-text">
                  {visibleSplits.length === 1 ? "Split" : "Splits"}
                </span>
                <Badge tone="count" size="xs">
                  {visibleSplits.length}
                </Badge>
              </div>
              <div className="mb-1 flex flex-col gap-[3px]">{visibleSplits.map(renderSplit)}</div>
            </div>
          )}
          {groups.map((group) => {
            // A `null` key is the flat list (Group by: None) — rows with no
            // heading over them at all, rather than one heading called
            // "Everything", which would be a header that says nothing.
            if (group.key === null) {
              return (
                <div key="__flat__" className="mb-1 flex flex-col gap-[3px] pt-1">
                  {group.sessions.map(renderEntry)}
                </div>
              )
            }
            const key = group.key
            // Collapse applies to repo grouping only (Status groups stay open).
            const collapsible = filters.groupBy === "repo" && Boolean(onToggleCollapsed)
            const collapsed = collapsible && (collapsedRepoNames?.has(key) ?? false)
            const isStatus = filters.groupBy === "status"
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
                    {isStatus ? (
                      <StatusDot status={displayStatusTone[key as SessionDisplayStatus]} size={8} />
                    ) : (
                      <GitBranch size={12} className="text-cyan" />
                    )}
                    <span
                      className={cn(
                        "flex-1 truncate text-[11.5px] font-semibold text-text",
                        isStatus ? "" : "font-mono"
                      )}
                    >
                      {isStatus ? displayStatusLabel[key as SessionDisplayStatus] : key}
                    </span>
                  </>
                )}
                {filters.groupBy === "repo" && onToggleStar && (
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
                  {group.sessions.length}
                </Badge>
              </div>
              {!collapsed && (
                <div className="mb-1 flex flex-col gap-[3px]">{group.sessions.map(renderEntry)}</div>
              )}
            </div>
            )
          })}
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

/** Docked width bounds. `initial` is the 266px the sidebar was hard-coded to. */
const SIDEBAR_WIDTH = { storageKey: "sb.sidebar.width", initial: 266, min: 200, max: 380 } as const

/** Below this much room for the whole shell, the sidebar becomes a rail. */
const RAIL_THRESHOLD = 1000

/** The collapsed rail's width — one avatar plus breathing room. */
const RAIL_WIDTH = 52

const PIN_STORAGE_KEY = "sb.sidebar.pinned"

/** How long the pointer must rest on a rail cell before its card opens. */
const HOVER_INTENT_MS = 150

const readPinned = (): boolean | null => {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY)
    return raw === null ? null : raw === "1"
  } catch {
    return null
  }
}

/**
 * The collapsed sidebar: one cell per session, status carried by the dot.
 *
 * Deliberately NOT a scaled-down copy of the full sidebar. Grouping, filtering
 * and the group-by control all need labels to mean anything, so the rail drops
 * them entirely and keeps only the two things that survive at 52px: which
 * sessions exist, and which one you're in. Everything else is one hover away —
 * per CELL, in a `SessionHoverCard`.
 *
 * That per-cell card replaced an earlier design where hovering the rail ANYWHERE
 * floated the entire sidebar back over the content. One hover gesture now means
 * one thing: "tell me about THIS session". Expanding is a deliberate click (or
 * ⌘B), because re-opening the whole sidebar is a layout change and layout
 * changes shouldn't happen to you in passing.
 */
function SessionRail({
  sessions,
  activeSessionId,
  liveActivity,
  prStates,
  onSelect,
  onNewSession,
  onExpand
}: {
  sessions: ReadonlyArray<Session>
  activeSessionId: string | null
  liveActivity?: Record<string, SessionActivity | undefined>
  prStates?: Record<string, SessionPrStatus>
  onSelect?: (id: string) => void
  onNewSession?: () => void
  /** Re-dock the sidebar (the top button). */
  onExpand: () => void
}) {
  const live = sessions.filter((s) => !s.archived)
  return (
    <div
      style={{ width: RAIL_WIDTH }}
      data-testid="session-rail"
      className="flex flex-none flex-col items-center gap-1 border-r border-hairline bg-panel py-2"
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Expand sidebar (⌘B)"
        className="flex size-8 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelLeft size={15} />
      </button>
      <button
        type="button"
        onClick={onNewSession}
        aria-label="New session"
        title="New session (⌘N)"
        className="flex size-8 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus size={15} />
      </button>
      <span className="my-1 h-px w-6 flex-none bg-hairline" />
      <div className="sb-no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {live.map((s) => {
          const active = s.id === activeSessionId
          const status = displayStatusOf(liveActivity?.[s.id], s.status)
          return (
            <HoverCard
              key={s.id}
              delayMs={HOVER_INTENT_MS}
              content={
                <SessionHoverCard
                  session={s}
                  activity={liveActivity?.[s.id]}
                  prState={prStates?.[s.id]}
                />
              }
            >
              <button
                type="button"
                onClick={() => onSelect?.(s.id)}
                aria-current={active ? "page" : undefined}
                // No `title` — the card IS the tooltip, and a native tooltip
                // fading in on top of it would cover the thing it duplicates.
                // The accessible NAME still carries the session's title.
                aria-label={s.title || UNTITLED_SESSION}
                className={cn(
                  "group relative flex size-8 flex-none items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  // The active cell was a half-opacity blue ring on a surface
                  // fill — two low-contrast signals that, at 32px against a
                  // panel that is nearly the same value, read as "slightly
                  // smudged" rather than as "you are here". It now gets the
                  // accent BAR (see below) plus a solid fill, and the ring is
                  // gone: a ring and a bar both claiming selection is one signal
                  // too many, and the bar is the one that survives at a glance.
                  // `bg-surface` for the fill matches `SessionRow`'s active
                  // treatment, so the same session looks selected the same way
                  // in both sidebar states.
                  active ? "bg-surface" : "hover:bg-surface/40"
                )}
              >
                {/* The rail's own left edge, not the cell's: 32px of cell centred
                    in 52px of rail leaves exactly 10px, so `-left-2.5` lands the
                    bar on the panel border where every editor puts it. */}
                {active && (
                  <span
                    aria-hidden
                    className="absolute -left-2.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-blue"
                  />
                )}
                {/* The HARNESS, not two initials. Initials of an auto-generated
                    title ("UN" for Untitled) say nothing you didn't already
                    know, and two sessions on the same feature collide; which
                    agent is driving is the fact you actually navigate by. */}
                <ProviderIcon
                  cli={s.cli}
                  size={16}
                  // Brand colour for the active session, monochrome for the
                  // rest — so the rail reads as one selected thing among peers
                  // rather than as a row of competing logos.
                  mono={!active}
                  className={cn(
                    "transition-colors",
                    !active && "text-muted-foreground group-hover:text-text"
                  )}
                />
                {/* Bottom-right rather than inline: a 32px cell has no room for a
                    dot beside the icon without pushing it off-centre. */}
                <span className="absolute -bottom-px -right-px">
                  <StatusDot status={displayStatusTone[status]} size={7} />
                </span>
              </button>
            </HoverCard>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The session sidebar, at whatever width the shell can spare.
 *
 * Above `RAIL_THRESHOLD` this is the docked, drag-resizable column it has always
 * been. Below it, the column becomes a 52px rail whose cells each carry a
 * `SessionHoverCard` — so collapsing costs REACH (one hover, one click) rather
 * than information.
 *
 * Either state can be forced with ⌘B or with the `PanelLeft` button, which
 * exists in both: in the docked header to collapse, at the top of the rail to
 * expand. The choice is persisted, so an operator who would rather give up
 * content width than navigate by hover only has to say so once.
 */
export function SessionSidebar(props: SessionSidebarProps) {
  // The SHELL's width, from the provider in `app-shell.tsx` — not this
  // component's own box, which is the sidebar and would always report ~266px
  // and so always claim to be cramped.
  const { width: shellWidth } = usePaneWidth()
  const { width, adjust } = useResizableWidth(SIDEBAR_WIDTH)
  const [pinned, setPinned] = React.useState<boolean | null>(readPinned)

  // `shellWidth === 0` is the pre-measurement frame; treat it as roomy so the
  // sidebar doesn't flash a rail on every launch before the observer reports.
  const cramped = shellWidth !== 0 && shellWidth < RAIL_THRESHOLD
  const expanded = pinned ?? !cramped

  const setPin = React.useCallback((next: boolean) => {
    setPinned(next)
    try {
      localStorage.setItem(PIN_STORAGE_KEY, next ? "1" : "0")
    } catch {
      /* private mode / quota — the pin is still live for this session */
    }
  }, [])

  // ⌘B toggles the pin. Deliberately a PIN and not a one-shot open: a toggle
  // that the next resize silently undoes is a control that lies about its state.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault()
        setPin(!(pinned ?? !cramped))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pinned, cramped, setPin])

  if (expanded) {
    return (
      <SidebarBody
        {...props}
        width={width}
        onResize={adjust}
        onCollapse={() => setPin(false)}
      />
    )
  }

  return (
    <SessionRail
      sessions={props.sessions}
      activeSessionId={props.activeSessionId}
      liveActivity={props.liveActivity}
      prStates={props.prStates}
      onSelect={props.onSelect}
      onNewSession={props.onNewSession}
      onExpand={() => setPin(true)}
    />
  )
}

