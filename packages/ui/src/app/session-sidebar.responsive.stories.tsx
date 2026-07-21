import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Session, SessionActivity } from "@starbase/core"
import { LookFor } from "../story-support.js"
import { WidthTierProvider } from "../hooks/width-tier.js"
import { SessionSidebar } from "./session-sidebar.js"

const meta: Meta = { title: "Responsive/Sidebar", parameters: { layout: "fullscreen" } }
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
  session({ id: "s1", title: "Refactor auth flow", repo: "starbase", diff: { added: 42, removed: 8 } }),
  session({ id: "s2", title: "Fix token refresh", repo: "starbase", prNumber: 47 }),
  session({ id: "s3", title: "Watch CI on #204", repo: "gtm-grid", prNumber: 204 }),
  session({ id: "s4", title: "Type-check watcher", repo: "gtm-grid" }),
  session({ id: "s5", title: "Awaiting approval", repo: "trigify-app" })
]

const ACTIVITY: Record<string, SessionActivity> = {
  s1: { kind: "thinking", verb: "Thinking", target: null },
  s2: { kind: "running", verb: "Running", target: "pnpm test -- auth" },
  s3: { kind: "monitoring", verb: "Monitoring PR", target: "#204" },
  s5: { kind: "needs-approval", verb: "Needs approval", target: null }
}

const args = {
  sessions: SESSIONS,
  activeSessionId: "s1",
  onSelect: () => {},
  liveActivity: ACTIVITY,
  version: "0.1.0"
}

/**
 * The sidebar reads the SHELL's width, not its own — so the rig here is a
 * shell-shaped box with the sidebar plus a stand-in content pane inside it,
 * rather than the `AtWidth` ladder the other stories use.
 *
 * A sidebar measuring itself would always report ~266px and so always claim to
 * be cramped; that bug is easy to reintroduce and this frame is where you'd see
 * it (the rail would show at 1400 too).
 */
function Shell({ width, label }: { width: number; label: string }) {
  return (
    <div className="flex flex-none flex-col gap-1.5">
      <div className="flex items-baseline gap-2 font-mono text-[10.5px]">
        <span className="text-text-bright">{width}px shell</span>
        <span className="text-dim">{label}</span>
      </div>
      <div
        style={{ width, height: 420 }}
        className="overflow-hidden rounded-[3px] border border-dashed border-line-strong"
      >
        <WidthTierProvider>
          <SessionSidebar {...args} />
          <div className="flex flex-1 items-center justify-center bg-editor text-[11px] text-dim">
            content
          </div>
        </WidthTierProvider>
      </div>
    </div>
  )
}

/**
 * Docked above 1000px of shell, a 52px icon rail below it.
 *
 * 266px was the only fixed column in the app that could not be dragged, and it
 * never collapsed — on a 900px window it took a third of everything.
 */
export const DockedVsRail: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the full sidebar at 1400 and 1100,
        the 52px rail at 900 and 820. In rail mode each session is two initials plus a status dot,
        and the active one carries a blue ring. Hover the rail for ~150ms to float the full sidebar
        over the content — the content behind must NOT reflow.
      </LookFor>
      <div className="flex items-start gap-5 overflow-auto p-6">
        <Shell width={1400} label="docked" />
        <Shell width={1100} label="docked" />
        <Shell width={900} label="rail" />
        <Shell width={820} label="rail" />
      </div>
    </div>
  )
}

/**
 * The threshold, either side by one pixel. Worth its own story because the
 * sidebar is the one component whose collapse changes the width every other
 * component sees.
 */
export const Threshold: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> exactly one difference. 1000 is
        docked, 999 is a rail. If both show the same thing, the sidebar is measuring itself instead
        of the shell.
      </LookFor>
      <div className="flex items-start gap-5 overflow-auto p-6">
        <Shell width={1000} label="threshold" />
        <Shell width={999} label="threshold − 1" />
      </div>
    </div>
  )
}

/**
 * Full width, now drag-resizable (200–380px) — which it never was before.
 *
 * Grab the right-hand edge. The width persists to localStorage, so it survives a
 * reload of this story.
 */
export const Resizable: Story = {
  render: () => (
    <div className="h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> a drag handle on the sidebar&apos;s
        right edge that highlights blue on hover, clamping at 200px and 380px. Also press{" "}
        <code>⌘B</code> — it pins the sidebar open regardless of width, and the pin persists.
      </LookFor>
      <div className="flex h-[calc(100vh-64px)]">
        <WidthTierProvider>
          <SessionSidebar {...args} />
          <div className="flex flex-1 items-center justify-center bg-editor text-[11px] text-dim">
            content
          </div>
        </WidthTierProvider>
      </div>
    </div>
  )
}
