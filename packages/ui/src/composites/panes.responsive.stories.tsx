import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Issue, PrFileChange, PullRequest as PullRequestData } from "@starbase/core"
import { LookFor, WidthLadder } from "../story-support.js"
import { CodeReviewView, type ReviewSource } from "./code-review-view.js"
import { IssueView } from "./issue-view.js"
import { PullRequestView } from "./pull-request-view.js"

const meta: Meta = { title: "Responsive/Panes", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const FILES: ReadonlyArray<PrFileChange> = [
  { path: "src/auth/session.ts", additions: 8, deletions: 3, commentCount: 2, viewed: false },
  { path: "src/auth/refresh.ts", additions: 42, deletions: 0, commentCount: 0, viewed: false },
  { path: "src/auth/token-store.ts", additions: 40, deletions: 0, commentCount: 0, viewed: true }
]

const DIFF = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "index 111..222 100644",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -31,6 +31,8 @@ export function session()",
  "   const s = req.session",
  "-  if (!s.token) return next()",
  "+  if (isExpired(s.token)) {",
  "+    await refresh(s)",
  "+  }",
  "   return next()",
  ""
].join("\n")

const FILE_DIFFS = FILES.map((f) => ({ path: f.path, diff: DIFF }))

const PR: PullRequestData = {
  number: 482,
  state: "open",
  title: "Add token store + refresh handling",
  body: "Adds a token store and refresh handling to the auth middleware.",
  url: "https://github.com/acme/x/pull/482",
  headRefName: "feat/oauth",
  baseRefName: "main",
  isDraft: false,
  author: { login: "claude-agent", avatarUrl: null },
  createdAt: "2026-07-21T08:00:00.000Z",
  commits: 6,
  changedFiles: 3,
  additions: 90,
  deletions: 3,
  labels: [
    { name: "auth", color: "c678dd" },
    { name: "needs-review", color: "e5c07b" }
  ],
  reviewers: [
    { login: "dan", state: "changes_requested" },
    { login: "you", state: "pending" }
  ],
  timeline: [
    {
      id: "r1",
      author: "dan",
      kind: "changes_requested",
      body: "The refresh guard should also handle the 401 retry path.",
      createdAt: "2026-07-21T09:00:00.000Z",
      path: "src/auth/session.ts",
      line: 34
    }
  ],
  reviewThreads: [],
  checks: [
    { name: "typecheck", status: "pass", url: null },
    { name: "test", status: "fail", url: null },
    { name: "build", status: "pending", url: null }
  ],
  mergeBlockers: [],
  mergeStateStatus: "CLEAN"
} as unknown as PullRequestData

const ISSUE: Issue = {
  number: 204,
  title: "Token refresh loops forever on a permanently invalid token",
  state: "open",
  body: "Repro: revoke the refresh token server-side, then make any authenticated call.",
  url: "https://github.com/acme/x/issues/204",
  author: { login: "morgan", avatarUrl: null },
  createdAt: "2026-07-20T08:00:00.000Z",
  labels: [{ name: "bug", color: "e06c75" }],
  assignees: [{ login: "morgan", avatarUrl: null }],
  comments: []
} as unknown as Issue

/**
 * Code Review: a file list, a diff, and a review tray.
 *
 * The two rails were 160px and 260px of `flex-none`, and `review-diff.tsx` spends
 * another 84px on fixed line-number gutters inside whatever is left. In a 500px
 * pane that came to roughly 70px of actual code — not a narrower view of the
 * diff so much as no view of it.
 */
export const CodeReview: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> both rails docked at 1240 and 720.
        At 500 and 380 they unmount from the row and two toggle buttons appear in the header —
        clicking either floats it as a sheet OVER the diff. The diff column should never fall below
        a readable width, and the header should wrap rather than clip its &quot;Finish review&quot;
        button.
      </LookFor>
      <WidthLadder height={420} render={() => <CodeReviewPane />} />
    </div>
  )
}

function CodeReviewPane() {
  const [source, setSource] = useState<ReviewSource>("pr")
  const [activePath, setActivePath] = useState<string | null>(FILES[0]!.path)
  return (
    <CodeReviewView
      files={FILES}
      activePath={activePath}
      fileDiffs={FILE_DIFFS}
      drafts={[]}
      routeTargetSession="Refactor auth flow"
      connected
      source={source}
      prAvailable
      localAvailable
      onSetSource={setSource}
      onSelectFile={setActivePath}
      onToggleViewed={() => {}}
      onAddDraft={() => {}}
      onRemoveDraft={() => {}}
      onFinishReview={() => {}}
    />
  )
}

/**
 * Pull Request: a 760px reading column beside a 352px rail.
 *
 * The rail was a hard `w-[352px] flex-none` with no resize handle at all. In a
 * 500px pane it left the PR body about 88px after its own 60px of gutter —
 * narrower than the PR title.
 */
export const PullRequestPane: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the rail docked at 1240 and 720. At
        500 and 380 it is replaced by a floating toggle at the top-right — the rail holds the MERGE
        button, so it can never simply be dropped. Opening it should not reflow the timeline
        underneath.
      </LookFor>
      <WidthLadder
        height={420}
        render={() => <PullRequestView pr={PR} connected sessionTitle="Refactor auth flow" />}
      />
    </div>
  )
}

/**
 * The Issue tab — the healthiest pane, with no side rails at all. Included as
 * the control case: if this one crowds, the problem is in a shared primitive
 * rather than in a pane's own layout.
 */
export const IssuePane: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the title row wrapping so its two
        action buttons drop below the heading rather than crushing it to one word, and the 32px
        gutters tightening to 16px below 560.
      </LookFor>
      <WidthLadder height={420} render={() => <IssueView issue={ISSUE} onOpen={() => {}} onUnlink={() => {}} />} />
    </div>
  )
}
