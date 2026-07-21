import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Session, SessionActivity, SessionPrStatus } from "@starbase/core"
import { WidthTierProvider } from "../hooks/width-tier.js"
import { LookFor } from "../story-support.js"
import { SessionSidebar } from "./session-sidebar.js"
import { DEFAULT_FILTERS, sessionFilterAxes, type SessionFilters } from "./session-filters.js"
import { FilterMenu } from "../components/filter-menu.js"

const meta: Meta = { title: "App/Filter Menu", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const session = (over: Partial<Session> & Pick<Session, "id" | "title">): Session => ({
  repo: "starbase",
  branch: `starbase/${over.id}`,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-21T10:00:00.000Z",
  archived: false,
  ...over
})

const SESSIONS: ReadonlyArray<Session> = [
  session({ id: "s1", title: "Implement company LinkedIn URLs", prNumber: 1642, updatedAt: "2026-07-21T14:00:00.000Z" }),
  session({ id: "s2", title: "Debug Inngest search results", prNumber: 1638, updatedAt: "2026-07-21T13:00:00.000Z" }),
  session({ id: "s3", title: "Investigate unspecified code issue", updatedAt: "2026-07-21T12:00:00.000Z" }),
  session({ id: "s4", title: "Create and test PR for bug fix", repo: "gtm-grid", prNumber: 1601, updatedAt: "2026-07-21T11:00:00.000Z" }),
  session({ id: "s5", title: "Dispatch background conversation", repo: "gtm-grid", updatedAt: "2026-07-21T09:00:00.000Z" }),
  session({ id: "s6", title: "Create PPR report generation", repo: "trigify-app", updatedAt: "2026-07-21T08:00:00.000Z" }),
  session({
    id: "s7",
    title: "Old auth spike",
    repo: "trigify-app",
    archived: true,
    updatedAt: "2026-07-12T08:00:00.000Z",
    archivedAt: "2026-07-20T16:00:00.000Z"
  }),
  session({
    id: "s8",
    title: "Abandoned migration",
    archived: true,
    updatedAt: "2026-07-19T08:00:00.000Z",
    archivedAt: "2026-07-19T18:00:00.000Z"
  })
]

const ACTIVITY: Record<string, SessionActivity> = {
  s1: { kind: "running", verb: "Running", target: "pnpm test" },
  s3: { kind: "needs-approval", verb: "Needs approval", target: null },
  s4: { kind: "monitoring", verb: "Monitoring PR", target: "#1601" }
}

const PR_STATES: Record<string, SessionPrStatus> = {
  s1: { state: "open", checks: "pass" },
  s2: { state: "open", checks: null },
  s4: { state: "open", checks: "fail" }
}

function Sidebar({ defaultFilters }: { defaultFilters?: SessionFilters }) {
  return (
    <div className="flex h-screen">
      <WidthTierProvider>
        <SessionSidebar
          sessions={SESSIONS}
          activeSessionId="s1"
          onSelect={() => {}}
          liveActivity={ACTIVITY}
          prStates={PR_STATES}
          onToggleStar={() => {}}
          onToggleCollapsed={() => {}}
          defaultFilters={defaultFilters}
          version="0.1.0"
        />
        <div className="flex flex-1 items-center justify-center bg-editor text-[11px] text-dim">
          content
        </div>
      </WidthTierProvider>
    </div>
  )
}

/**
 * The menu, live.
 *
 * It replaced a permanent "GROUP BY [Repository|Status]" segmented control AND
 * an "Archived" group pinned to the bottom of the list. Two axes already cost a
 * row of chrome above the list they filter; four would have cost more vertical
 * space than the first three sessions.
 */
export const Live: Story = {
  render: () => (
    <div className="h-screen">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the sliders button beside the search
        box. Each axis row shows its CURRENT value when the menu is shut, so nothing is hidden —
        only folded. The hairline splits narrowing (Status, Repository) from arranging (Group by,
        Sort by). Narrowing the list puts a blue dot on the button; grouping and sorting do not,
        because they hide nothing.
      </LookFor>
      <div className="h-[calc(100vh-72px)]">
        <Sidebar />
      </div>
    </div>
  )
}

/**
 * Archived is a FILTER now, not a place.
 *
 * The old Archived group meant a session could be in two places — its repo group
 * or the archive — and the archive was on screen forever to serve something you
 * look at monthly. One model now: filtered in, or filtered out.
 */
export const ArchivedIsAFilter: Story = {
  render: () => (
    <div className="h-screen">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> two archived sessions that are
        invisible on Active (the default), the only two on Archived, and interleaved into their repo
        groups on All. Set Status → Archived from the menu and watch the repo headings change.
      </LookFor>
      <div className="h-[calc(100vh-72px)]">
        <Sidebar defaultFilters={{ ...DEFAULT_FILTERS, status: "archived" }} />
      </div>
    </div>
  )
}

/**
 * Group by: None — a flat list, no headings at all.
 *
 * Not a heading called "Everything": a header that says nothing is worse than no
 * header. Combined with Sort by: Recency this is the closest thing to a plain
 * "most recent first" list.
 */
export const FlatAndSorted: Story = {
  render: () => (
    <div className="h-screen">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> no repo headings, rows in strict
        recency order across every repo. Switch Sort by → Name and the same flat list re-orders
        alphabetically.
      </LookFor>
      <div className="h-[calc(100vh-72px)]">
        <Sidebar defaultFilters={{ ...DEFAULT_FILTERS, groupBy: "none", sortBy: "recency" }} />
      </div>
    </div>
  )
}

/**
 * The menu on its own, with its state echoed beneath it.
 *
 * The axes are built by a pure function (`sessionFilterAxes`) that returns DATA,
 * so the menu component is dumb and the axes can be asserted in a unit test
 * without mounting Radix — which portals, animates and needs a real pointer to
 * open a flyout.
 */
export const MenuOnly: Story = {
  render: () => {
    const [filters, setFilters] = useState<SessionFilters>(DEFAULT_FILTERS)
    return (
      <div className="flex min-h-screen flex-col items-start gap-6 bg-panel p-10">
        <FilterMenu axes={sessionFilterAxes(filters, setFilters, SESSIONS)}>
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1.5 text-[12.5px] text-text-body hover:bg-surface"
          >
            Filter & sort
          </button>
        </FilterMenu>
        <pre className="rounded-md border border-line bg-sunken p-4 font-mono text-[11.5px] text-muted-foreground">
          {JSON.stringify(filters, null, 2)}
        </pre>
      </div>
    )
  }
}
