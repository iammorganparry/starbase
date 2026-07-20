import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SessionSidebar } from "./session-sidebar.js"
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
