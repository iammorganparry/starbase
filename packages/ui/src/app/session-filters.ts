import type { Session, SessionDisplayStatus } from "@starbase/core"

/**
 * How the sidebar's session list is narrowed and arranged.
 *
 * Deliberately React-free and side-effect-free apart from the two storage
 * functions at the bottom — same posture as `split-layout.ts`. Every rule about
 * what the list SHOWS lives here as a pure function, so the sidebar component
 * downstream is only plumbing, and the awkward cases (a repo that vanishes while
 * it is the active filter, a group that empties, ordering ties) are cheap to
 * test.
 */

/**
 * Which slice of a session's life the list is showing.
 *
 * This replaced a permanent "Archived" group pinned to the bottom of the
 * sidebar. That group was a second place a session could be, which meant two
 * mental models — a session was either in its repo group or in the archive — and
 * the archive was on screen forever to serve something you look at monthly.
 * Archived is a FILTER now: one model, and the default hides them.
 */
export type StatusFilter = "active" | "archived" | "all"

/** How rows are bucketed. `none` is a flat list with no headers at all. */
export type GroupBy = "none" | "repo" | "status"

/** The order within each bucket. */
export type SortBy = "recency" | "name" | "status"

export interface SessionFilters {
  readonly status: StatusFilter
  /** A repo name, or null for "every repository". */
  readonly repo: string | null
  readonly groupBy: GroupBy
  readonly sortBy: SortBy
}

/**
 * Today's behaviour, expressed as a filter set.
 *
 * `status: "active"` and `groupBy: "repo"` are what the sidebar did before this
 * module existed — the menu opens on the layout you already had, so introducing
 * it changes nothing until you touch it.
 */
export const DEFAULT_FILTERS: SessionFilters = {
  status: "active",
  repo: null,
  groupBy: "repo",
  sortBy: "recency"
}

export const STATUS_LABEL: Record<StatusFilter, string> = {
  active: "Active",
  archived: "Archived",
  all: "All"
}

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  none: "None",
  repo: "Repository",
  status: "Status"
}

export const SORT_BY_LABEL: Record<SortBy, string> = {
  recency: "Recency",
  name: "Name",
  status: "Status"
}

/**
 * Status groups render in this order (most-active first).
 *
 * "thinking" is absent, and that is NOT an oversight: `statusOf` folds it into
 * "running" so a session doesn't hop groups every time a tool starts and stops.
 * A group is a place in a list, and a place that moves every few seconds is
 * worse than a coarser one that holds still.
 */
export const STATUS_ORDER: ReadonlyArray<SessionDisplayStatus> = [
  "needs-input",
  "running",
  "monitoring",
  "idle"
]

/** Sort rank for `sortBy: "status"` — the same most-active-first order. */
const statusRank = (s: SessionDisplayStatus): number => {
  const i = STATUS_ORDER.indexOf(s)
  // An unranked status (only "thinking", which `statusOf` folds away) sorts last
  // rather than first, which is what `indexOf`'s -1 would otherwise do.
  return i === -1 ? STATUS_ORDER.length : i
}

/** Every repo present in `sessions`, alphabetical — the Repository submenu. */
export const repoOptions = (sessions: ReadonlyArray<Session>): ReadonlyArray<string> =>
  [...new Set(sessions.map((s) => s.repo))].sort((a, b) => a.localeCompare(b))

/** Free-text match across the three fields a person actually types. */
const matchesQuery = (s: Session, q: string): boolean =>
  s.title.toLowerCase().includes(q) ||
  s.branch.toLowerCase().includes(q) ||
  s.repo.toLowerCase().includes(q)

/**
 * Narrow `sessions` by the query and the filter set.
 *
 * Order of the two is irrelevant (both are predicates) but keeping them in one
 * pass means the list is walked once per render rather than three times.
 */
export const filterSessions = (
  sessions: ReadonlyArray<Session>,
  query: string,
  filters: SessionFilters
): ReadonlyArray<Session> => {
  const q = query.trim().toLowerCase()
  return sessions.filter((s) => {
    if (filters.status === "active" && s.archived) return false
    if (filters.status === "archived" && !s.archived) return false
    if (filters.repo !== null && s.repo !== filters.repo) return false
    if (q && !matchesQuery(s, q)) return false
    return true
  })
}

/**
 * Order a bucket.
 *
 * `recency` is not simply `updatedAt` for archived rows. A session you archived
 * today whose last turn was a week ago would sort below sessions archived days
 * earlier, so the one you just retired — or lost by accident — is buried
 * mid-list exactly when you go looking for it. When a row is archived, the
 * moment that matters is when it was archived.
 *
 * Returns a new array; the input is never mutated (callers pass memoized props).
 */
export const sortSessions = (
  sessions: ReadonlyArray<Session>,
  sortBy: SortBy,
  statusOf: (s: Session) => SessionDisplayStatus
): ReadonlyArray<Session> => {
  const recencyKey = (s: Session) => (s.archived ? (s.archivedAt ?? "") : s.updatedAt)
  return [...sessions].sort((a, b) => {
    switch (sortBy) {
      case "name":
        return a.title.localeCompare(b.title)
      case "status": {
        const rank = statusRank(statusOf(a)) - statusRank(statusOf(b))
        // Ties broken by recency, not left to sort stability: within "idle"
        // there is no reason to prefer whichever order the store happened to
        // hand us, and the newest is the one you're most likely to want.
        return rank !== 0 ? rank : recencyKey(b).localeCompare(recencyKey(a))
      }
      default:
        return recencyKey(b).localeCompare(recencyKey(a))
    }
  })
}

/** One bucket of the rendered list. `key` is null for the ungrouped flat list. */
export interface SessionGroup {
  readonly key: string | null
  readonly sessions: ReadonlyArray<Session>
}

/**
 * Bucket + order the filtered list, ready to render.
 *
 * Empty groups never appear: a status with nothing in it, or a repo filtered
 * down to nothing, simply isn't a heading. A heading over nothing reads as a
 * loading state.
 */
export const groupSessions = (
  sessions: ReadonlyArray<Session>,
  filters: SessionFilters,
  statusOf: (s: Session) => SessionDisplayStatus,
  starredRepoNames?: ReadonlySet<string>
): ReadonlyArray<SessionGroup> => {
  const sorted = sortSessions(sessions, filters.sortBy, statusOf)

  if (filters.groupBy === "none") {
    // A single null-keyed group rather than a separate shape, so the renderer
    // has one branch instead of two.
    return sorted.length === 0 ? [] : [{ key: null, sessions: sorted }]
  }

  if (filters.groupBy === "status") {
    const byStatus = new Map<SessionDisplayStatus, Array<Session>>()
    for (const s of sorted) {
      const status = statusOf(s)
      const list = byStatus.get(status)
      if (list) list.push(s)
      else byStatus.set(status, [s])
    }
    return STATUS_ORDER.filter((s) => byStatus.has(s)).map((s) => ({
      key: s,
      sessions: byStatus.get(s)!
    }))
  }

  const byRepo = new Map<string, Array<Session>>()
  for (const s of sorted) {
    const list = byRepo.get(s.repo)
    if (list) list.push(s)
    else byRepo.set(s.repo, [s])
  }
  const groups = [...byRepo].map(([key, list]) => ({ key, sessions: list }))
  if (!starredRepoNames || starredRepoNames.size === 0) return groups
  // Stable sort: starred repo groups float to the top, order otherwise kept —
  // which means repos stay in first-seen order rather than jumping alphabetical.
  return [...groups].sort(
    (a, b) => Number(starredRepoNames.has(b.key)) - Number(starredRepoNames.has(a.key))
  )
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const FILTERS_STORAGE_KEY = "sb.sidebar.filters.v1"

const isStatus = (v: unknown): v is StatusFilter =>
  v === "active" || v === "archived" || v === "all"
const isGroupBy = (v: unknown): v is GroupBy => v === "none" || v === "repo" || v === "status"
const isSortBy = (v: unknown): v is SortBy => v === "recency" || v === "name" || v === "status"

/**
 * Read the persisted filters, falling back per-FIELD rather than wholesale.
 *
 * A stored object with one unrecognised value (a filter removed in a later
 * version, a hand-edited store) should lose that one field, not silently reset
 * the other three. Same defensive posture as `split-layout`'s `load`.
 *
 * `repo` is validated as a string but NOT checked against the repos that
 * currently exist — that check belongs at render time, where the session list is
 * known. See `reconcileRepo`.
 */
export const loadFilters = (): SessionFilters => {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY)
    if (raw === null) return DEFAULT_FILTERS
    const parsed = JSON.parse(raw) as Partial<SessionFilters>
    return {
      status: isStatus(parsed.status) ? parsed.status : DEFAULT_FILTERS.status,
      repo: typeof parsed.repo === "string" && parsed.repo !== "" ? parsed.repo : null,
      groupBy: isGroupBy(parsed.groupBy) ? parsed.groupBy : DEFAULT_FILTERS.groupBy,
      sortBy: isSortBy(parsed.sortBy) ? parsed.sortBy : DEFAULT_FILTERS.sortBy
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

/** Persist the filters. Best-effort: a full or absent store is not an error. */
export const saveFilters = (filters: SessionFilters): void => {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters))
  } catch {
    /* private mode / quota — the filters are still live for this session */
  }
}

/**
 * Drop a repo filter that names a repo no longer present.
 *
 * A persisted `repo` outlives the sessions that justified it: delete the last
 * session in that repo, or open the app on another machine, and the filter would
 * match nothing — an empty sidebar with no visible cause, because the filter
 * that emptied it names something that isn't in the menu either.
 *
 * Applied only when there ARE sessions: an empty list on first paint is loading,
 * not an absent repo, and clearing on it would discard the filter every launch.
 */
export const reconcileRepo = (
  filters: SessionFilters,
  sessions: ReadonlyArray<Session>
): SessionFilters => {
  if (filters.repo === null || sessions.length === 0) return filters
  return sessions.some((s) => s.repo === filters.repo) ? filters : { ...filters, repo: null }
}

/** Whether anything is narrowed — drives the button's "active" dot. */
export const isNarrowed = (filters: SessionFilters): boolean =>
  filters.status !== DEFAULT_FILTERS.status || filters.repo !== null

// ---------------------------------------------------------------------------
// Menu model
// ---------------------------------------------------------------------------

/** One value within an axis, as the menu renders it. */
export interface FilterAxisOption {
  readonly value: string
  readonly label: string
  readonly count?: number
}

/** One axis of the filter menu — a row plus the flyout it opens. */
export interface FilterAxisModel {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<FilterAxisOption>
  readonly onSelect: (value: string) => void
  readonly separated?: boolean
}

/** The sentinel the Repository axis uses for "every repository". */
export const ALL_REPOS = "__all__"

/**
 * The four axes, built from the sessions that actually exist.
 *
 * Pure and returned as DATA rather than JSX so the menu's contents can be
 * asserted in a unit test without mounting Radix — which portals, animates, and
 * needs a pointer to open a flyout. The component that renders these is dumb by
 * construction.
 *
 * `separated` splits the menu in two: the first pair NARROW the list (what is
 * shown), the second pair ARRANGE it (how what's shown is laid out). Those are
 * different questions and the hairline says so.
 *
 * Counts come from `sessions`, which callers pass already narrowed by the search
 * box: while you're typing, "Archived 3" should mean three MATCHES, not three in
 * existence.
 */
export const sessionFilterAxes = (
  filters: SessionFilters,
  onChange: (next: SessionFilters) => void,
  sessions: ReadonlyArray<Session>
): ReadonlyArray<FilterAxisModel> => {
  const repos = repoOptions(sessions)
  const archived = sessions.filter((s) => s.archived).length

  return [
    {
      id: "status",
      label: "Status",
      value: filters.status,
      options: [
        { value: "active", label: STATUS_LABEL.active, count: sessions.length - archived },
        { value: "archived", label: STATUS_LABEL.archived, count: archived },
        { value: "all", label: STATUS_LABEL.all, count: sessions.length }
      ],
      onSelect: (v) => onChange({ ...filters, status: v as StatusFilter })
    },
    {
      id: "repo",
      label: "Repository",
      value: filters.repo ?? ALL_REPOS,
      options: [
        { value: ALL_REPOS, label: "All", count: sessions.length },
        ...repos.map((repo) => ({
          value: repo,
          label: repo,
          count: sessions.filter((s) => s.repo === repo).length
        }))
      ],
      onSelect: (v) => onChange({ ...filters, repo: v === ALL_REPOS ? null : v })
    },
    {
      id: "groupBy",
      label: "Group by",
      value: filters.groupBy,
      separated: true,
      options: (["none", "repo", "status"] as const).map((v) => ({
        value: v,
        label: GROUP_BY_LABEL[v]
      })),
      onSelect: (v) => onChange({ ...filters, groupBy: v as GroupBy })
    },
    {
      id: "sortBy",
      label: "Sort by",
      value: filters.sortBy,
      options: (["recency", "name", "status"] as const).map((v) => ({
        value: v,
        label: SORT_BY_LABEL[v]
      })),
      onSelect: (v) => onChange({ ...filters, sortBy: v as SortBy })
    }
  ]
}
