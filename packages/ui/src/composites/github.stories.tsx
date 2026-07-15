import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PrFileChange, PullRequest as PullRequestData } from "@starbase/core"
import { PullRequestView } from "./pull-request-view.js"
import { CodeReviewView, type ReviewSource } from "./code-review-view.js"
import { SettingsDialog } from "./settings-dialog.js"

const meta: Meta = { title: "GitHub", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const pr: PullRequestData = {
  number: 482,
  state: "open",
  title: "Add token store + refresh handling",
  body: "Adds a token store and refresh handling to the auth middleware.",
  url: "https://github.com/acme/x/pull/482",
  headRefName: "feat/oauth",
  baseRefName: "main",
  isDraft: false,
  author: { login: "claude-agent", avatarUrl: null },
  createdAt: "2026-07-11T08:00:00.000Z",
  commits: 6,
  changedFiles: 4,
  additions: 128,
  deletions: 32,
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
      body: "The refresh guard should also handle the 401 retry path — right now a stale token 500s instead of refreshing.",
      createdAt: "2026-07-11T09:00:00.000Z",
      path: "src/auth/session.ts",
      line: 34
    }
  ],
  checks: [
    { name: "build", status: "pass", detailsUrl: null, durationMs: 72_000 },
    { name: "unit tests", status: "pass", detailsUrl: null, durationMs: 48_000 },
    { name: "e2e", status: "running", detailsUrl: null, durationMs: null },
    { name: "lint", status: "fail", detailsUrl: "https://ci/lint", durationMs: null }
  ],
  mergeable: "CONFLICTING",
  mergeStateStatus: "BLOCKED",
  mergeBlockers: ["1 failing check (lint)", "1 change requested"]
}

/** The Pull Request tab — open PR with checks, reviewers, and a blocked merge. */
export const PullRequestOpen: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView pr={pr} connected sessionTitle="Refactor auth flow" />
    </div>
  )
}

/** Draft PR — the side panel offers "Ready for review" instead of merge. */
export const PullRequestDraft: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView
        pr={{ ...pr, state: "draft", isDraft: true, mergeBlockers: [] }}
        connected
        sessionTitle="Refactor auth flow"
        onMarkReady={() => {}}
      />
    </div>
  )
}

/** Empty state — no PR yet; offers to create one. */
export const PullRequestEmpty: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView pr={null} connected sessionTitle="Refactor auth flow" />
    </div>
  )
}

const files: ReadonlyArray<PrFileChange> = [
  { path: "src/auth/session.ts", additions: 8, deletions: 3, commentCount: 2, viewed: false },
  { path: "src/auth/refresh.ts", additions: 42, deletions: 0, commentCount: 0, viewed: false }
]

const fileDiff = [
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

/** The Code Review tab — a two-source diff (PR / Uncommitted) with revert on local. */
export const CodeReview: Story = {
  render: () => {
    const [source, setSource] = useState<ReviewSource>("local")
    return (
      <div className="flex h-screen bg-editor">
        <CodeReviewView
          files={files}
          activePath="src/auth/session.ts"
          fileDiffs={[
            { path: "src/auth/session.ts", diff: fileDiff },
            { path: "src/auth/refresh.ts", diff: fileDiff }
          ]}
          drafts={[]}
          routeTargetSession="Refactor auth flow"
          connected
          source={source}
          prAvailable
          localAvailable
          onSetSource={setSource}
          onSelectFile={() => {}}
          onToggleViewed={() => {}}
          onAddDraft={() => {}}
          onRemoveDraft={() => {}}
          onFinishReview={() => {}}
          onRevertLines={() => {}}
          onRevertFile={() => {}}
        />
      </div>
    )
  }
}

/** The Settings view — the GitHub integration section (connected). */
export const Settings: Story = {
  render: () => (
    <SettingsDialog
      open
      ghStatus={{
        available: true,
        authenticated: true,
        login: "iammorganparry",
        host: "github.com",
        version: "2.68.1"
      }}
      github={{ enabled: true, autoCreatePr: false, autoDetectPr: true }}
      onRecheck={() => {}}
      onSaveGithub={() => {}}
      onClose={() => {}}
    />
  )
}
