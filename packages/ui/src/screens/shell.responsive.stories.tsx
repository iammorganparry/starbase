import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Session, SessionActivity } from "@starbase/core"
import { LookFor } from "../story-support.js"
import { WidthTierProvider } from "../hooks/width-tier.js"
import { SessionSidebar } from "../app/session-sidebar.js"
import { SessionSplit } from "../app/session-split.js"
import { TerminalDock } from "../app/terminal-panel.js"
import { maxPanesForWidth } from "../app/split-layout.js"
import type { SplitGroup } from "../app/split-layout.js"

const meta: Meta = { title: "Responsive/Shell", parameters: { layout: "fullscreen" } }
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
  worktreePath: `/tmp/${over.id}`,
  ...over
})

const SESSIONS: ReadonlyArray<Session> = [
  session({ id: "s1", title: "Refactor auth flow", diff: { added: 42, removed: 8 } }),
  session({ id: "s2", title: "Fix token refresh", prNumber: 47 }),
  session({ id: "s3", title: "Watch CI on #204", repo: "gtm-grid", prNumber: 204 }),
  session({ id: "s4", title: "Type-check watcher", repo: "gtm-grid" })
]

const ACTIVITY: Record<string, SessionActivity> = {
  s1: { kind: "thinking", verb: "Thinking", target: null },
  s2: { kind: "running", verb: "Running", target: "pnpm test -- auth" }
}

const groupOf = (ids: ReadonlyArray<string>): SplitGroup => ({
  id: `g:${ids[0]}`,
  panes: ids.map((sessionId) => ({ sessionId, ratio: 1 / ids.length })),
  focused: 0
})

/**
 * A whole shell at one window size — sidebar, split, and optionally a dock.
 *
 * `WidthTierProvider` here stands in for the one `AppShell` installs around the
 * content row. Everything below reads its width: the sidebar decides rail vs
 * docked, both docks decide right vs bottom, and each pane installs its own
 * narrower provider for its tab bar and composer.
 */
function Shell({
  width,
  height = 560,
  paneIds,
  label,
  dock
}: {
  width: number
  height?: number
  paneIds: ReadonlyArray<string>
  label?: string
  dock?: "right" | "bottom"
}) {
  const [terminalOpen, setTerminalOpen] = useState(Boolean(dock))
  return (
    <div className="flex flex-none flex-col gap-1.5">
      <div className="flex items-baseline gap-2 font-mono text-[10.5px]">
        <span className="text-text-bright">{width}px</span>
        <span className="text-dim">
          {paneIds.length} pane{paneIds.length === 1 ? "" : "s"} · seats{" "}
          {maxPanesForWidth(width - 266)}
          {label ? ` · ${label}` : ""}
        </span>
      </div>
      <div
        style={{ width, height }}
        className="overflow-hidden rounded-[3px] border border-dashed border-line-strong bg-editor"
      >
        <WidthTierProvider>
          <SessionSidebar
            sessions={SESSIONS}
            activeSessionId={paneIds[0] ?? null}
            onSelect={() => {}}
            liveActivity={ACTIVITY}
            version="0.1.0"
          />
          <SessionSplit
            group={groupOf(paneIds)}
            sessions={SESSIONS}
            planSessions={new Set(["s1"])}
            liveActivity={ACTIVITY}
            terminalDockSide={dock ?? "bottom"}
            renderTerminalDock={
              dock
                ? () => (
                    <TerminalDock
                      dock={dock}
                      onDockChange={() => {}}
                      visible={terminalOpen}
                      onToggle={() => setTerminalOpen((v) => !v)}
                      tabs={[{ id: "t1", title: "zsh", status: "running" }]}
                      activeId="t1"
                      onSelect={() => {}}
                      onNew={() => {}}
                      onClose={() => {}}
                      cwdLabel="~/starbase/worktrees/s1"
                      renderTerminal={() => (
                        <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-dim">
                          terminal
                        </div>
                      )}
                    />
                  )
                : undefined
            }
          />
        </WidthTierProvider>
      </div>
    </div>
  )
}

/**
 * One pane, from a maximised window down to the app's own minimum (900×600).
 *
 * Every collapse in the sweep is visible here at once: sidebar → rail, tab
 * labels → icons, pane actions → menu, composer toolbar → wrapped.
 */
export const WindowSizes: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> at 1440 nothing has changed from
        today&apos;s layout. At 1100 the sidebar is still docked but tab labels have gone. At 900 —
        the window minimum, and what half a 1800px display gives you — the sidebar is a rail and
        the pane is still fully usable. Nothing should be clipped at any size.
      </LookFor>
      <div className="flex items-start gap-5 overflow-auto p-6">
        <Shell width={1440} paneIds={["s1"]} />
        <Shell width={1100} paneIds={["s1"]} />
        <Shell width={900} paneIds={["s1"]} label="window minimum" />
      </div>
    </div>
  )
}

/**
 * The case that started this: a split, in a half-screen window.
 *
 * `MIN_RATIO` is a proportion, not a floor — 0.15 of a 1174px row is ~176px,
 * narrower than a single diff row's fixed gutters. `maxPanesForWidth` is the
 * floor, and the readout above each frame shows how many panes the row can seat.
 */
export const SplitAtHalfScreen: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> two panes at 1240 each keeping a
        working tab bar and composer. At 960 both panes are ~350px and everything in them should be
        icon-only with a <code>⋯</code> menu — but nothing clipped. The &quot;seats&quot; readout is
        the cap the split will now enforce on a drop.
      </LookFor>
      <div className="flex items-start gap-5 overflow-auto p-6">
        <Shell width={1600} paneIds={["s1", "s2", "s3"]} />
        <Shell width={1240} paneIds={["s1", "s2"]} />
        <Shell width={960} paneIds={["s1", "s2"]} label="half of 1920" />
      </div>
    </div>
  )
}

/**
 * A right-docked terminal, either side of the 1100px threshold.
 *
 * A right dock takes 300px minimum on top of the sidebar; two of them open on a
 * 900px window left nothing for a pane at all. Below the threshold it flips to
 * the bottom — the axis the shell has far more of — and the operator's chosen
 * side is remembered, not overwritten.
 */
export const DockFlip: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> both frames were told{" "}
        <code>dock=&quot;right&quot;</code>. At 1400 the terminal is on the right; at 1000 it has
        moved to the bottom and draws a TOP border rather than a left one. If it renders in the
        bottom row while still drawing a left border, placement and appearance have disagreed.
      </LookFor>
      <div className="flex items-start gap-5 overflow-auto p-6">
        <Shell width={1400} paneIds={["s1"]} dock="right" label="right dock honoured" />
        <Shell width={1000} paneIds={["s1"]} dock="right" label="forced to bottom" />
      </div>
    </div>
  )
}

/**
 * Four panes, which only the widest windows can now seat.
 *
 * At the bottom width the split would previously have allowed all four at ~176px
 * each; the readout shows the cap that now applies instead.
 */
export const PaneCap: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the &quot;seats&quot; readout
        falling as the window narrows. Existing panes are never evicted — the cap only refuses a new
        drop, so a 4-pane layout carried over from a wider window still renders.
      </LookFor>
      <div className="flex items-start gap-5 overflow-auto p-6">
        <Shell width={1920} paneIds={["s1", "s2", "s3", "s4"]} />
        <Shell width={1400} paneIds={["s1", "s2", "s3", "s4"]} label="over cap — kept, not evicted" />
      </div>
    </div>
  )
}
