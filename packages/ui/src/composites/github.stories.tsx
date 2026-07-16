import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type {
  AdversarialReview,
  PrFileChange,
  PullRequest as PullRequestData
} from "@starbase/core"
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
  // Mirrors what GitHub returns for a bot review: raw-HTML badge + <details>
  // block, an outdated thread (live anchor nulled), a reply, and a reaction.
  reviewThreads: [
    {
      id: "PRRT_1",
      reviewId: "PRR_1",
      path: "src/auth/session.ts",
      line: null,
      startLine: null,
      originalLine: 38,
      originalStartLine: 34,
      diffHunk: `@@ -30,7 +31,11 @@ export function session({
   const token = useToken()

+  // Refresh once, then retry the original request.
+  useEffect(() => {
+    if (!expired) return
+    void refresh()
+  }, [expired])`,
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
          body: `<a href="#"><img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=9" align="top"></a> **Stale token 500s instead of refreshing**\n\nThe \`useEffect\` refresh fires after the request has already failed.\n\n<details><summary>Prompt To Fix With AI</summary>\n\nMove the refresh ahead of the request.\n\n</details>`,
          createdAt: "2026-07-11T09:05:00.000Z",
          reactions: []
        },
        {
          id: "PRRC_2",
          databaseId: 1002,
          author: "claude-agent",
          authorAvatarUrl: null,
          isBot: false,
          association: "OWNER",
          body: "✅ Addressed in `1f8653e` — the refresh now runs before the request.",
          createdAt: "2026-07-11T10:20:00.000Z",
          reactions: [{ content: "THUMBS_UP", count: 1 }]
        }
      ]
    },
    {
      id: "PRRT_2",
      reviewId: "PRR_1",
      path: "src/auth/token-store.ts",
      line: 91,
      startLine: null,
      originalLine: 91,
      originalStartLine: null,
      diffHunk: `@@ -88,3 +88,4 @@ export const store = {
   get: () => cache.token,
+  clear: () => cache.token = null,`,
      isResolved: true,
      isOutdated: false,
      resolvedBy: "greptile-apps[bot]",
      comments: [
        {
          id: "PRRC_3",
          databaseId: 1003,
          author: "greptile-apps",
          authorAvatarUrl: null,
          isBot: true,
          association: "NONE",
          body: "`clear()` doesn't reset the refresh timer.",
          createdAt: "2026-07-11T09:06:00.000Z",
          reactions: []
        }
      ]
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

const adversarialReview: AdversarialReview = {
  sessionId: "s1",
  prNumber: 482,
  headSha: "9f3c1ab7d2e4f5061728394a5b6c7d8e9f0a1b2c",
  cli: "claude",
  model: "claude-fable-5",
  createdAt: "2026-07-16T10:00:00.000Z",
  note: null,
  findings: [
    {
      id: "f1",
      path: "src/auth/session.ts",
      line: 42,
      endLine: null,
      severity: "critical",
      title: "Session token compared with ===",
      rationale:
        "String comparison short-circuits on the first differing byte, so an attacker can recover the token one character at a time by measuring response latency.",
      suggestion: "Compare with crypto.timingSafeEqual over equal-length buffers."
    },
    {
      id: "f2",
      path: "src/auth/refresh.ts",
      line: 88,
      endLine: 94,
      severity: "major",
      title: "Refresh retries forever on a permanently invalid token",
      rationale:
        "The retry loop has no terminal case for a 401. A revoked refresh token spins until the request times out, holding the connection open.",
      suggestion: "Break on 4xx and surface the failure to the caller."
    },
    {
      id: "f3",
      path: null,
      line: null,
      endLine: null,
      severity: "minor",
      title: "No test covers the expired-token path",
      rationale:
        "Every new test exercises the happy path. The refresh branch this PR adds is the risky one and is untested.",
      suggestion: null
    }
  ]
}

/** The adversarial review panel — findings ranked worst-first in the right rail. */
export const PullRequestAdversarialReview: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView
        pr={{ ...pr, mergeBlockers: [] }}
        connected
        sessionTitle="Refactor auth flow"
        review={{
          review: adversarialReview,
          running: false,
          onRun: () => {},
          onSendFindingToAgent: () => {},
          sentFindingIds: new Set(["f2"])
        }}
      />
    </div>
  )
}

/** A clean review — the reviewer argued and found nothing. */
export const PullRequestReviewClean: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView
        pr={{ ...pr, mergeBlockers: [] }}
        connected
        sessionTitle="Refactor auth flow"
        review={{
          review: { ...adversarialReview, findings: [] },
          running: false,
          onRun: () => {}
        }}
      />
    </div>
  )
}

/** The reviewer ran but produced no parseable findings — its words are surfaced. */
export const PullRequestReviewNote: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView
        pr={{ ...pr, mergeBlockers: [] }}
        connected
        sessionTitle="Refactor auth flow"
        review={{
          review: {
            ...adversarialReview,
            findings: [],
            note: "I can't review this diff — it touches credential-handling code I'm not able to analyse."
          },
          running: false,
          onRun: () => {}
        }}
      />
    </div>
  )
}

/** A review in flight. */
export const PullRequestReviewRunning: Story = {
  render: () => (
    <div className="flex h-screen bg-editor">
      <PullRequestView
        pr={{ ...pr, mergeBlockers: [] }}
        connected
        sessionTitle="Refactor auth flow"
        review={{ review: null, running: true, onRun: () => {} }}
      />
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

/**
 * Code Review with adversarial findings anchored to their files. The third
 * finding names a file that is NOT in this diff — it collects into "general"
 * rather than vanishing.
 */
export const CodeReviewWithFindings: Story = {
  render: () => {
    const [source, setSource] = useState<ReviewSource>("pr")
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
          review={{
            ...adversarialReview,
            findings: [
              ...adversarialReview.findings,
              {
                id: "f4",
                path: "src/unrelated/helper.ts",
                line: 3,
                endLine: null,
                severity: "minor",
                title: "Finding on a file outside this diff",
                rationale:
                  "The reviewer read this file for context. It isn't in the PR, so the finding collects under General rather than being dropped.",
                suggestion: null
              }
            ]
          }}
          onSendFindingToAgent={() => {}}
          sentFindingIds={new Set(["f2"])}
        />
      </div>
    )
  }
}

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
