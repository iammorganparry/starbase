import type { Session } from "@starbase/core"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SessionPane, visibleTabs } from "./session-pane.js"

afterEach(cleanup)

const session = (over: Partial<Session> & { id: string }): Session =>
  ({
    repo: "gtm-grid",
    branch: `starbase/${over.id}`,
    title: over.id,
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-16T00:00:00.000Z",
    worktreePath: `/tmp/${over.id}`,
    baseBranch: "main",
    mode: "auto",
    ...over
  }) as Session

describe("visibleTabs", () => {
  it("shows only Conversation for a bare session", () => {
    expect(visibleTabs(session({ id: "a", worktreePath: undefined }))).toEqual(["conversation"])
  })

  it("adds Issue when an issue is linked", () => {
    expect(visibleTabs(session({ id: "a", issueNumber: 7 }))).toContain("issue")
  })

  it("adds Plan only for sessions in the plan set", () => {
    const s = session({ id: "a" })
    expect(visibleTabs(s, new Set(["a"]))).toContain("plan")
    expect(visibleTabs(s, new Set(["other"]))).not.toContain("plan")
  })

  it("swaps Changes for Review once a PR exists", () => {
    expect(visibleTabs(session({ id: "a" }))).toContain("changes")
    expect(visibleTabs(session({ id: "a", prNumber: 12 }))).toContain("review")
    expect(visibleTabs(session({ id: "a", prNumber: 12 }))).not.toContain("changes")
  })
})

describe("SessionPane", () => {
  it("renders the session it was given, not one looked up from a list", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
      />
    )
    expect(screen.getByText(/transcript for a/)).toBeTruthy()
  })

  it("keeps tab state independent between two mounted panes", () => {
    // The whole reason for the extraction: a shared `tab` useState in the parent
    // could never let two gridded panes sit on different tabs.
    const { container } = render(
      <>
        <div data-testid="pane-a">
          <SessionPane
            session={session({ id: "a", prNumber: 1 })}
            renderConversation={(s) => <div>transcript {s.id}</div>}
            renderPullRequest={(s) => <div>pr view {s.id}</div>}
          />
        </div>
        <div data-testid="pane-b">
          <SessionPane
            session={session({ id: "b", prNumber: 2 })}
            renderConversation={(s) => <div>transcript {s.id}</div>}
            renderPullRequest={(s) => <div>pr view {s.id}</div>}
          />
        </div>
      </>
    )
    expect(container).toBeTruthy()

    // Move pane A to its Pull Request tab; pane B must stay on Conversation.
    const paneA = screen.getByTestId("pane-a")
    fireEvent.click(within(paneA).getByText("Pull Request"))

    expect(within(paneA).getByText("pr view a")).toBeTruthy()
    expect(within(screen.getByTestId("pane-b")).getByText("transcript b")).toBeTruthy()
  })

  it("falls back to Conversation when the selected tab stops being available", () => {
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a", prNumber: 5 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderReview={() => <div>review view</div>}
      />
    )
    fireEvent.click(screen.getByText("Code Review"))
    expect(screen.getByText("review view")).toBeTruthy()

    // The PR goes away (merged and unlinked) — Review is no longer a visible tab,
    // so the pane must not be left showing a tab that isn't in the bar.
    rerender(
      <SessionPane
        session={session({ id: "a", prNumber: null })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderReview={() => <div>review view</div>}
      />
    )
    expect(screen.queryByText("review view")).toBeNull()
    expect(screen.getByText("transcript a")).toBeTruthy()
  })

  it("routes a plan deep-link to the Plan view for its own session", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["a"])}
        renderConversation={(s, view, ctx) => (
          <div>
            <button onClick={() => ctx.onOpenPlanReview("s_02")}>jump</button>
            <span>
              {view}:{s.id}:{ctx.planStepId ?? "none"}
            </span>
          </div>
        )}
      />
    )
    fireEvent.click(screen.getByText("jump"))
    expect(screen.getByText("plan:a:s_02")).toBeTruthy()
  })
})
