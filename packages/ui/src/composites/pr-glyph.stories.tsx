import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Session, SessionPrStatus } from "@starbase/core"
import { SessionSidebar } from "../app/session-sidebar.js"
import { WidthTierProvider } from "../hooks/width-tier.js"
import { prGlyphOf, PrStatusGlyph } from "./pr-glyph.js"

const meta: Meta = { title: "App/PR Status Glyph", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

/** Every state a row can be in, in the order they occur in a PR's life. */
const STATES: ReadonlyArray<{ pr: SessionPrStatus | null; when: string }> = [
  { pr: null, when: "no PR yet — just a branch" },
  { pr: { state: "draft", checks: null }, when: "opened as a draft" },
  { pr: { state: "draft", checks: "running" }, when: "draft, CI started" },
  { pr: { state: "open", checks: null }, when: "open, repo has no CI" },
  { pr: { state: "open", checks: "pending" }, when: "open, checks queued" },
  { pr: { state: "open", checks: "running" }, when: "open, checks running" },
  { pr: { state: "open", checks: "fail" }, when: "open, something broke" },
  { pr: { state: "open", checks: "pass" }, when: "open, green — mergeable" },
  { pr: { state: "merged", checks: null }, when: "merged" },
  { pr: { state: "closed", checks: null }, when: "closed without merging" }
]

/**
 * The full vocabulary.
 *
 * Two independent facts, two channels: the SHAPE says where the PR is in its
 * life, the COLOUR says whether CI is happy. The corner mark is spent only on
 * the two answers worth a second glyph — green tick for clean, red cross for
 * broken.
 */
export const Vocabulary: Story = {
  render: () => (
    <div className="min-h-screen bg-panel p-8">
      <div className="flex flex-col gap-3">
        {STATES.map(({ pr, when }) => {
          const glyph = prGlyphOf(pr)
          return (
            <div key={when} className="flex items-center gap-4">
              <PrStatusGlyph pr={pr} size={16} />
              <span className="w-[220px] text-[12.5px] text-text-bright">{glyph.label}</span>
              <span className="font-mono text-[11px] text-dim">{when}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The glyph at its real size, in a real sidebar.
 *
 * The leading slot used to hold the AGENT's activity dot. The PR won it on scan
 * value: what the agent is doing changes every few seconds and is already
 * spelled out as a word on the line below, where it can't be mistaken for
 * anything else. Where a PR stands changes a few times a day and previously had
 * no at-a-glance representation at all.
 */
export const InTheSidebar: Story = {
  render: () => {
    const session = (id: string, title: string, over: Partial<Session> = {}): Session => ({
      id,
      title,
      repo: "starbase",
      branch: `starbase/${id}`,
      status: "idle",
      cli: "claude",
      diff: { added: 42, removed: 8 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-21T10:00:00.000Z",
      archived: false,
      ...over
    })

    const sessions = [
      session("s1", "Implement company LinkedIn URLs", { prNumber: 1642 }),
      session("s2", "Debug Inngest search results", { prNumber: 1638 }),
      session("s3", "Investigate unspecified code issue"),
      session("s4", "Create and test PR for bug fix", { prNumber: 1601 }),
      session("s5", "Create pull request for code review", { prNumber: 1655 }),
      session("s6", "Dispatch background conversation"),
      session("s7", "Fix HTTP configuration issue", { prNumber: 1590 })
    ]

    const prStates: Record<string, SessionPrStatus> = {
      s1: { state: "open", checks: "pass" },
      s2: { state: "open", checks: null },
      s4: { state: "open", checks: "fail" },
      s5: { state: "open", checks: "pass" },
      s7: { state: "merged", checks: null }
    }

    return (
      <div className="flex h-screen">
        <WidthTierProvider>
          <SessionSidebar
            sessions={sessions}
            activeSessionId="s1"
            onSelect={() => {}}
            prStates={prStates}
            version="0.1.0"
          />
          <div className="flex flex-1 items-center justify-center bg-editor text-[11px] text-dim">
            content
          </div>
        </WidthTierProvider>
      </div>
    )
  }
}
