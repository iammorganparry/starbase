import type { PrReviewThread } from "@starbase/core"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { PrReviewThreadView } from "./pr-review-thread.js"

afterEach(cleanup)

const thread = (over: Partial<PrReviewThread> = {}): PrReviewThread => ({
  id: "PRRT_1",
  reviewId: "PRR_1",
  path: "apps/desktop/src/renderer/conversation-pane.tsx",
  line: null,
  startLine: null,
  originalLine: 38,
  originalStartLine: 31,
  diffHunk: "@@ -27,9 +28,19 @@\n   const convo = useConversation(session)",
  isResolved: false,
  isOutdated: true,
  resolvedBy: null,
  comments: [
    {
      id: "PRRC_1",
      databaseId: 1001,
      author: "greptile-apps",
      authorAvatarUrl: null,
      isBot: true,
      association: "NONE",
      body: "Prefilled draft lost",
      createdAt: "2026-07-15T20:15:10Z",
      reactions: []
    }
  ],
  ...over
})

describe("PrReviewThreadView anchor caption", () => {
  it("falls back to the original anchor when GitHub has nulled the live one", () => {
    // The common case: any thread on a PR pushed to since review is outdated,
    // and GitHub nulls line/startLine — but still shows "lines +31 to +38".
    render(<PrReviewThreadView thread={thread()} />)
    expect(screen.getByText("Comment on lines +31 to +38")).toBeDefined()
  })

  it("prefers the live anchor when the thread is current", () => {
    render(
      <PrReviewThreadView
        thread={thread({ line: 415, startLine: 376, originalLine: 406, originalStartLine: 376, isOutdated: false })}
      />
    )
    expect(screen.getByText("Comment on lines +376 to +415")).toBeDefined()
  })

  it("renders a single-line caption when there is no start line", () => {
    render(<PrReviewThreadView thread={thread({ originalLine: 273, originalStartLine: null })} />)
    expect(screen.getByText("Comment on line +273")).toBeDefined()
  })

  it("omits the caption entirely when GitHub reports no anchor at all", () => {
    render(<PrReviewThreadView thread={thread({ originalLine: null, originalStartLine: null })} />)
    expect(screen.queryByText(/Comment on line/)).toBeNull()
  })
})

describe("PrReviewThreadView state", () => {
  it("shows the Outdated badge and starts expanded when unresolved", () => {
    render(<PrReviewThreadView thread={thread()} />)
    expect(screen.getByText("Outdated")).toBeDefined()
    expect(screen.getByText("Prefilled draft lost")).toBeDefined()
  })

  it("starts collapsed when resolved — GitHub's 'Show resolved'", () => {
    render(
      <PrReviewThreadView thread={thread({ isResolved: true, resolvedBy: "greptile-apps[bot]" })} />
    )
    expect(screen.getByText("Resolved")).toBeDefined()
    // Body is hidden until the operator expands the thread.
    expect(screen.queryByText("Prefilled draft lost")).toBeNull()
  })

  it("labels a bot commenter by __typename, not association", () => {
    render(<PrReviewThreadView thread={thread()} />)
    expect(screen.getByText("Bot")).toBeDefined()
    // association is NONE for bots, so it must not produce a chip.
    expect(screen.queryByText("None")).toBeNull()
  })

  it("offers Resolve when open and Unresolve when already resolved", () => {
    const { unmount } = render(<PrReviewThreadView thread={thread()} onResolve={() => {}} />)
    expect(screen.getByText("Resolve conversation")).toBeDefined()
    unmount()

    render(
      <PrReviewThreadView
        thread={thread({ isResolved: true, resolvedBy: "greptile-apps[bot]" })}
        onResolve={() => {}}
      />
    )
    // Collapsed, so the footer is hidden until expanded.
    expect(screen.queryByText("Unresolve conversation")).toBeNull()
  })
})
