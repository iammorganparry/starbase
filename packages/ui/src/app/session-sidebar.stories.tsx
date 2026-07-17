import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Session, SessionActivity } from "@starbase/core"
import { SessionSidebar } from "./session-sidebar.js"

const meta = {
  title: "App/SessionSidebar",
  component: SessionSidebar,
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof SessionSidebar>

export default meta
type Story = StoryObj<typeof meta>

const session = (over: Partial<Session> & Pick<Session, "id" | "title">): Session => ({
  repo: "starbase",
  branch: "starbase/witty-berners",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-17T10:00:00.000Z",
  archived: false,
  ...over
})

/**
 * One session per reportable state, plus the two that used to leak their
 * innards. A row says one of five words and nothing else — the tool and its
 * target moved to the hover title, where they can't shove the branch name out of
 * the row.
 */
const SESSIONS: ReadonlyArray<Session> = [
  session({ id: "s1", title: "Refactor auth flow", repo: "starbase", diff: { added: 42, removed: 8 } }),
  session({ id: "s2", title: "Fix token refresh", repo: "starbase", prNumber: 47 }),
  session({ id: "s3", title: "Watch CI on #204", repo: "gtm-grid", prNumber: 204 }),
  session({ id: "s4", title: "Type-check watcher", repo: "gtm-grid" }),
  session({ id: "s5", title: "Awaiting approval", repo: "trigify-app" }),
  session({ id: "s6", title: "Big Triage", repo: "trigify-app", status: "idle" }),
  session({ id: "s7", title: "Finished run", repo: "trigify-app", status: "done" })
]

/**
 * The activities behind the rows. `s1`/`s2` carry a long target on purpose —
 * before, the row read "Running git branch --show-current" and ellipsized over
 * the branch; now both read "Running".
 */
const ACTIVITY: Record<string, SessionActivity> = {
  s1: { kind: "thinking", verb: "Thinking", target: null },
  s2: { kind: "running", verb: "Running", target: "git branch --show-current && pnpm test -- auth" },
  s3: { kind: "monitoring", verb: "Monitoring PR", target: "#204" },
  // A non-CI watcher — also Monitoring: it's a process that won't return.
  s4: { kind: "watching", verb: "Watching", target: "tsc --watch --preserveWatchOutput" },
  s5: { kind: "needs-approval", verb: "Needs approval", target: null }
}

/** Grouped by repo (the default) — every state visible at once. */
export const AllStates: Story = {
  args: {
    sessions: SESSIONS,
    activeSessionId: "s1",
    onSelect: () => {},
    liveActivity: ACTIVITY,
    version: "0.1.0"
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}

/**
 * A reading/editing session. Both report "Running" — the conversation header
 * keeps "Reading session.ts"; a row in a list has no room for the distinction
 * and no reader scanning the column wants it.
 */
export const ToolWorkAllReadsAsRunning: Story = {
  args: {
    sessions: [
      session({ id: "r1", title: "Reading", repo: "starbase" }),
      session({ id: "r2", title: "Editing", repo: "starbase" }),
      session({ id: "r3", title: "Delegating", repo: "starbase" }),
      session({ id: "r4", title: "Searching the web", repo: "starbase" })
    ],
    activeSessionId: "r1",
    onSelect: () => {},
    liveActivity: {
      r1: { kind: "reading", verb: "Reading", target: "conversation.ts" },
      r2: { kind: "editing", verb: "Editing", target: "session-row.tsx" },
      r3: { kind: "delegating", verb: "Delegating", target: "Explore the plan pane" },
      r4: { kind: "web", verb: "Searching the web", target: "effect schema optionalWith" }
    }
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}
