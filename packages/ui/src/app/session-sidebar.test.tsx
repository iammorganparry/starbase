import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SessionSidebar } from "./session-sidebar.js"
import type { SplitGroup } from "./split-layout.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)

const rowOrder = () =>
  Array.from(document.querySelectorAll("[data-testid^='session-row-']")).map((el) =>
    el.getAttribute("data-testid")!.replace("session-row-", "")
  )

describe("SessionSidebar archived group", () => {
  it("orders archived sessions by when they were ARCHIVED, not last updated", () => {
    // The regression: `sessions` arrives ordered by `updatedAt`. A session whose
    // last turn was days ago but which was archived just now must still surface at
    // the top of the group — otherwise the session you just lost is buried
    // mid-list exactly when you go looking for it.
    render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        sessions={[
          session({
            id: "recently-updated",
            updatedAt: "2026-07-18T07:00:00.000Z",
            archived: true,
            archiveReason: "merged",
            archivedAt: "2026-07-18T08:00:00.000Z"
          }),
          session({
            id: "stale-but-just-archived",
            updatedAt: "2026-07-16T15:42:00.000Z",
            archived: true,
            archiveReason: "merged",
            archivedAt: "2026-07-18T14:25:00.000Z"
          })
        ]}
      />
    )

    expect(rowOrder()).toStrictEqual(["stale-but-just-archived", "recently-updated"])
  })

  it("keeps a merged-PR session in its repo group instead of archiving it", () => {
    // A session holds ONE prNumber but can outlive several PRs, so a merged PR
    // badges the row and leaves the session active. Only `archived` retires it.
    render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        sessions={[session({ id: "multi-pr", prNumber: 204 })]}
        prStates={{ "multi-pr": "merged" }}
      />
    )

    expect(rowOrder()).toStrictEqual(["multi-pr"])
    expect(screen.getByText(/#204 Merged/)).toBeDefined()
  })
})

/**
 * A split is ONE sidebar row, drawn at one of its members' positions. Which
 * member owns that row is the whole subject here: the first version keyed on
 * `panes[0]` outright, so any list that didn't happen to contain the first pane
 * rendered no pill at all — and the split stayed on screen with nothing in the
 * sidebar pointing at it.
 */
describe("SessionSidebar split pill ownership", () => {
  const SPLIT: SplitGroup = {
    id: "g:first",
    panes: [
      { sessionId: "first", ratio: 0.5 },
      { sessionId: "second", ratio: 0.5 }
    ],
    focused: 0
  }

  const renderSidebar = (sessions: ReadonlyArray<ReturnType<typeof session>>) =>
    render(
      <SessionSidebar
        activeSessionId="first"
        onSelect={() => {}}
        sessions={sessions}
        splitGroups={[SPLIT]}
        activeGroupId="g:first"
      />
    )

  const both = [
    session({ id: "first", title: "Refactor auth flow" }),
    session({ id: "second", title: "Bump the toolchain" })
  ]

  it("draws the pill once, at the first pane, when everything is showing", () => {
    renderSidebar(both)
    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
    expect(screen.getByTestId("split-segment-first")).toBeDefined()
    expect(screen.getByTestId("split-segment-second")).toBeDefined()
    // And neither member is ALSO drawn as a plain row.
    expect(rowOrder()).toStrictEqual([])
  })

  it("still draws the pill when the filter matches only a LATER pane", () => {
    // The regression: searching for pane 2's title left pane 1 with no entry to
    // hang the pill on, while pane 2's entry bowed out for not being first. The
    // search found a session and then rendered nothing whatsoever.
    renderSidebar(both)
    fireEvent.change(screen.getByPlaceholderText("Filter sessions…"), {
      target: { value: "toolchain" }
    })

    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
    expect(screen.getByTestId("split-segment-second")).toBeDefined()
  })

  it("still draws the pill when the FIRST pane's session is missing from the list", () => {
    // Defence in depth, using archiving as the way to make a member absent.
    //
    // The app no longer reaches this state — archiving evicts a session from its
    // split (`use-split-layout`'s prune) precisely so it can't be in two sidebar
    // places at once. But this component takes `splitGroups` as data and cannot
    // police where it came from: a stale persisted workspace arriving one render
    // before the prune runs looks exactly like this. Ownership must not depend
    // on `panes[0]` being present, and that is what this pins.
    renderSidebar([
      session({ id: "first", title: "Refactor auth flow", archived: true, archivedAt: "2026-07-18T08:00:00.000Z" }),
      session({ id: "second", title: "Bump the toolchain" })
    ])

    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
    // The archived member still appears in the Archived group as its own row —
    // it IS archived, and it IS on screen; both are true and both are shown.
    expect(rowOrder()).toStrictEqual(["first"])
  })

  it("draws no pill when the filter excludes every pane", () => {
    renderSidebar(both)
    fireEvent.change(screen.getByPlaceholderText("Filter sessions…"), {
      target: { value: "nothing matches this" }
    })

    expect(screen.queryByTestId("split-row-g:first")).toBeNull()
  })

  it("draws ONE pill for a split that spans two repo groups", () => {
    // Ownership is resolved against the whole active list, not per rendered
    // group — resolving it per group would draw the same pill in both repos.
    renderSidebar([
      session({ id: "first", title: "Refactor auth flow", repo: "starbase" }),
      session({ id: "second", title: "Bump the toolchain", repo: "gtm-grid" })
    ])

    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
  })
})
