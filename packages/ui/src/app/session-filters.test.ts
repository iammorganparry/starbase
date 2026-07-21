import type { Session, SessionDisplayStatus } from "@starbase/core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { testSession } from "../test-support.js"
import {
  ALL_REPOS,
  DEFAULT_FILTERS,
  FILTERS_STORAGE_KEY,
  filterSessions,
  groupSessions,
  isNarrowed,
  loadFilters,
  reconcileRepo,
  repoOptions,
  saveFilters,
  sessionFilterAxes,
  sortSessions,
  type SessionFilters
} from "./session-filters.js"

beforeEach(() => localStorage.clear())

const idle = (): SessionDisplayStatus => "idle"

const s = (over: Parameters<typeof testSession>[0]) => testSession(over)

const SESSIONS: ReadonlyArray<Session> = [
  s({ id: "a", title: "Charlie", repo: "starbase", updatedAt: "2026-07-21T10:00:00.000Z" }),
  s({ id: "b", title: "Alpha", repo: "starbase", updatedAt: "2026-07-21T12:00:00.000Z" }),
  s({ id: "c", title: "Bravo", repo: "gtm-grid", updatedAt: "2026-07-21T11:00:00.000Z" }),
  s({
    id: "d",
    title: "Delta",
    repo: "gtm-grid",
    archived: true,
    updatedAt: "2026-07-14T09:00:00.000Z",
    archivedAt: "2026-07-21T13:00:00.000Z"
  })
]

describe("filterSessions", () => {
  it("hides archived sessions by default", () => {
    const out = filterSessions(SESSIONS, "", DEFAULT_FILTERS)
    expect(out.map((x) => x.id)).toStrictEqual(["a", "b", "c"])
  })

  it("shows only archived when asked", () => {
    const out = filterSessions(SESSIONS, "", { ...DEFAULT_FILTERS, status: "archived" })
    expect(out.map((x) => x.id)).toStrictEqual(["d"])
  })

  it("interleaves everything on All", () => {
    expect(filterSessions(SESSIONS, "", { ...DEFAULT_FILTERS, status: "all" })).toHaveLength(4)
  })

  it("narrows to one repo", () => {
    const out = filterSessions(SESSIONS, "", { ...DEFAULT_FILTERS, repo: "gtm-grid" })
    expect(out.map((x) => x.id)).toStrictEqual(["c"])
  })

  it("ANDs the query with the filters rather than replacing them", () => {
    // Searching must not resurrect archived rows the Status filter excluded —
    // that would make the filter feel like it silently lapses whenever you type.
    const out = filterSessions(SESSIONS, "delta", DEFAULT_FILTERS)
    expect(out).toHaveLength(0)
  })

  it("matches title, branch and repo", () => {
    expect(filterSessions(SESSIONS, "gtm", DEFAULT_FILTERS).map((x) => x.id)).toStrictEqual(["c"])
    expect(filterSessions(SESSIONS, "starbase/a", DEFAULT_FILTERS).map((x) => x.id)).toStrictEqual(["a"])
  })
})

describe("sortSessions", () => {
  it("orders by recency, newest first", () => {
    const out = sortSessions(SESSIONS.slice(0, 3), "recency", idle)
    expect(out.map((x) => x.id)).toStrictEqual(["b", "c", "a"])
  })

  it("uses archivedAt for an archived row, not updatedAt", () => {
    // A session archived today whose last turn was a week ago must still surface
    // at the top — otherwise the one you just retired is buried exactly when you
    // go looking for it.
    const out = sortSessions(SESSIONS, "recency", idle)
    expect(out[0]!.id).toBe("d")
  })

  it("orders by name alphabetically", () => {
    const out = sortSessions(SESSIONS, "name", idle)
    expect(out.map((x) => x.title)).toStrictEqual(["Alpha", "Bravo", "Charlie", "Delta"])
  })

  it("orders by status most-active-first, breaking ties on recency", () => {
    const byId: Record<string, SessionDisplayStatus> = {
      a: "idle",
      b: "needs-input",
      c: "idle",
      d: "running"
    }
    const out = sortSessions(SESSIONS, "status", (x) => byId[x.id]!)
    // needs-input, running, then the two idles newest-first (c is 11:00, a 10:00).
    expect(out.map((x) => x.id)).toStrictEqual(["b", "d", "c", "a"])
  })

  it("does not mutate its input", () => {
    const input = SESSIONS.slice(0, 3)
    const before = input.map((x) => x.id)
    sortSessions(input, "name", idle)
    expect(input.map((x) => x.id)).toStrictEqual(before)
  })
})

describe("groupSessions", () => {
  const active = SESSIONS.filter((x) => !x.archived)

  it("returns one null-keyed group for the flat list", () => {
    const out = groupSessions(active, { ...DEFAULT_FILTERS, groupBy: "none" }, idle)
    expect(out).toHaveLength(1)
    expect(out[0]!.key).toBeNull()
    expect(out[0]!.sessions).toHaveLength(3)
  })

  it("returns nothing at all for an empty list, rather than an empty group", () => {
    // A heading over nothing reads as a loading state.
    expect(groupSessions([], { ...DEFAULT_FILTERS, groupBy: "none" }, idle)).toStrictEqual([])
    expect(groupSessions([], DEFAULT_FILTERS, idle)).toStrictEqual([])
  })

  it("groups by repo in first-seen order", () => {
    const out = groupSessions(active, DEFAULT_FILTERS, idle)
    expect(out.map((g) => g.key)).toStrictEqual(["starbase", "gtm-grid"])
  })

  it("floats starred repos to the top without reordering the rest", () => {
    const out = groupSessions(active, DEFAULT_FILTERS, idle, new Set(["gtm-grid"]))
    expect(out.map((g) => g.key)).toStrictEqual(["gtm-grid", "starbase"])
  })

  it("omits status groups with nothing in them", () => {
    const byId: Record<string, SessionDisplayStatus> = { a: "idle", b: "idle", c: "running" }
    const out = groupSessions(active, { ...DEFAULT_FILTERS, groupBy: "status" }, (x) => byId[x.id]!)
    expect(out.map((g) => g.key)).toStrictEqual(["running", "idle"])
  })

  it("sorts within each group, not just across the whole list", () => {
    const out = groupSessions(active, { ...DEFAULT_FILTERS, sortBy: "name" }, idle)
    const starbase = out.find((g) => g.key === "starbase")!
    expect(starbase.sessions.map((x) => x.title)).toStrictEqual(["Alpha", "Charlie"])
  })
})

describe("persistence", () => {
  it("round-trips", () => {
    const filters: SessionFilters = { status: "all", repo: "starbase", groupBy: "none", sortBy: "name" }
    saveFilters(filters)
    expect(loadFilters()).toStrictEqual(filters)
  })

  it("falls back per FIELD, not wholesale", () => {
    // One unrecognised value (a filter removed in a later version, a hand-edited
    // store) must not silently reset the other three.
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({ status: "nonsense", repo: "starbase", groupBy: "none", sortBy: "name" })
    )
    expect(loadFilters()).toStrictEqual({
      status: DEFAULT_FILTERS.status,
      repo: "starbase",
      groupBy: "none",
      sortBy: "name"
    })
  })

  it("survives junk on disk", () => {
    localStorage.setItem(FILTERS_STORAGE_KEY, "{not json")
    expect(loadFilters()).toStrictEqual(DEFAULT_FILTERS)
  })

  it("does not throw when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(() => saveFilters(DEFAULT_FILTERS)).not.toThrow()
    spy.mockRestore()
  })
})

describe("reconcileRepo", () => {
  it("drops a repo filter naming a repo that no longer exists", () => {
    // Left alone it would empty the sidebar with no visible cause — the filter
    // that emptied it isn't in the menu either.
    const filters = { ...DEFAULT_FILTERS, repo: "deleted-repo" }
    expect(reconcileRepo(filters, SESSIONS).repo).toBeNull()
  })

  it("keeps a repo filter that still matches", () => {
    const filters = { ...DEFAULT_FILTERS, repo: "starbase" }
    expect(reconcileRepo(filters, SESSIONS)).toBe(filters)
  })

  it("leaves the filter alone while the list is empty", () => {
    // An empty list on first paint is loading, not an absent repo. Clearing on
    // it would discard the filter on every launch.
    const filters = { ...DEFAULT_FILTERS, repo: "starbase" }
    expect(reconcileRepo(filters, [])).toBe(filters)
  })
})

describe("isNarrowed", () => {
  it("is true only when something is HIDDEN", () => {
    expect(isNarrowed(DEFAULT_FILTERS)).toBe(false)
    expect(isNarrowed({ ...DEFAULT_FILTERS, status: "all" })).toBe(true)
    expect(isNarrowed({ ...DEFAULT_FILTERS, repo: "starbase" })).toBe(true)
    // Grouping and sorting rearrange what's there; they hide nothing.
    expect(isNarrowed({ ...DEFAULT_FILTERS, groupBy: "none", sortBy: "name" })).toBe(false)
  })
})

describe("sessionFilterAxes", () => {
  it("offers the four axes, split into narrowing and arranging", () => {
    const axes = sessionFilterAxes(DEFAULT_FILTERS, () => {}, SESSIONS)
    expect(axes.map((a) => a.id)).toStrictEqual(["status", "repo", "groupBy", "sortBy"])
    expect(axes.find((a) => a.id === "groupBy")!.separated).toBe(true)
  })

  it("builds the repository list from the sessions that exist", () => {
    const repoAxis = sessionFilterAxes(DEFAULT_FILTERS, () => {}, SESSIONS).find((a) => a.id === "repo")!
    expect(repoAxis.options.map((o) => o.value)).toStrictEqual([ALL_REPOS, "gtm-grid", "starbase"])
  })

  it("counts archived and active separately", () => {
    const status = sessionFilterAxes(DEFAULT_FILTERS, () => {}, SESSIONS).find((a) => a.id === "status")!
    expect(status.options.map((o) => o.count)).toStrictEqual([3, 1, 4])
  })

  it("maps the All sentinel back to null", () => {
    let got: SessionFilters | null = null
    const axes = sessionFilterAxes({ ...DEFAULT_FILTERS, repo: "starbase" }, (f) => (got = f), SESSIONS)
    axes.find((a) => a.id === "repo")!.onSelect(ALL_REPOS)
    expect(got!.repo).toBeNull()
  })
})

describe("repoOptions", () => {
  it("de-duplicates and sorts alphabetically", () => {
    expect(repoOptions(SESSIONS)).toStrictEqual(["gtm-grid", "starbase"])
  })
})
