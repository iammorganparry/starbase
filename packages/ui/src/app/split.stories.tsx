import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Session } from "@starbase/core"
import { Columns2 } from "lucide-react"
import { SessionRow } from "../composites/session-row.js"
import { SplitRow } from "../composites/split-row.js"
import { RepoPicker } from "../composites/repo-picker.js"
import { StatusDot } from "../components/status-dot.js"
import { displayStatusTone } from "../tokens.js"
import { SplitView } from "./split-view.js"
import {
  activate,
  activeGroup,
  closePane,
  EMPTY_WORKSPACE,
  focusPane,
  groupOf,
  MAX_PANES,
  replacePane,
  resize,
  separateAll,
  show,
  splitWith,
  type Workspace
} from "./split-layout.js"

/**
 * The split, driven end to end with no app running.
 *
 * These stories exist to be JUDGED, not just to render: the harness below owns
 * real `Workspace` state and pushes every interaction through the same pure
 * reducers the app will use, so splitting, closing, reordering, resizing and
 * separating here behave exactly as they will in Electron. What changes is only
 * what's INSIDE a pane — a cheap placeholder rather than a live transcript.
 *
 * Mirrors Arc's behaviour deliberately; each story's description says which part.
 */

const session = (over: Partial<Session> & Pick<Session, "id" | "title">): Session => ({
  repo: "starbase",
  branch: "starbase/witty-berners",
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

const FIXTURE: ReadonlyArray<Session> = [
  session({ id: "s1", title: "Refactor auth flow", repo: "starbase", status: "running", diff: { added: 42, removed: 8 } }),
  session({ id: "s2", title: "Fix token refresh", repo: "starbase", prNumber: 47 }),
  session({ id: "s3", title: "Watch CI on #204", repo: "gtm-grid", status: "running", prNumber: 204 }),
  session({ id: "s4", title: "Type-check watcher", repo: "gtm-grid" }),
  session({ id: "s5", title: "Awaiting approval", repo: "trigify-app", status: "needs-input" }),
  session({ id: "s6", title: "Big triage sweep", repo: "trigify-app" }),
  session({ id: "s7", title: "Rewrite the composer", repo: "starbase", status: "running" }),
  session({ id: "s8", title: "Bump the toolchain", repo: "gtm-grid" })
]

const byId = (id: string): Session => FIXTURE.find((s) => s.id === id)!

/**
 * Build a workspace: each array is one group, in sidebar order.
 *
 * The FIRST group ends up active — building them left to right would otherwise
 * leave the last one on screen, so a story about a split would open showing the
 * single session listed after it.
 */
const workspaceOf = (...groups: ReadonlyArray<ReadonlyArray<string>>): Workspace => {
  const built = groups.reduce<Workspace>((ws, ids) => {
    const seeded = show(ws, ids[0]!)
    const groupId = groupOf(seeded, ids[0]!)!.id
    return ids.slice(1).reduce((acc, id, i) => splitWith(acc, groupId, id, i + 1), seeded)
  }, EMPTY_WORKSPACE)
  return activate(built, built.groups[0]!.id)
}

/**
 * What a pane shows in Storybook. Deliberately cheap — the point of these
 * stories is the split's geometry and motion, not a transcript.
 */
function PlaceholderPane({ session: s, index }: { session: Session; index: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-hairline bg-sunken px-3">
        <StatusDot status={displayStatusTone[s.status === "running" ? "running" : "idle"]} size={7} />
        <span className="truncate text-[12.5px] text-text">{s.title}</span>
        <span className="ml-auto font-mono text-[10px] text-dim">pane {index + 1}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 p-4">
        <div className="h-2 w-3/4 rounded bg-panel" />
        <div className="h-2 w-1/2 rounded bg-panel" />
        <div className="h-2 w-2/3 rounded bg-panel" />
        <div className="mt-3 h-9 rounded-lg border border-hairline bg-sunken" />
      </div>
    </div>
  )
}

/**
 * The harness: real workspace state, real reducers, fake panes.
 *
 * Everything the app will wire up is wired here — which is what makes this an
 * approval gate rather than a screenshot.
 */
function SplitPlayground({ initial }: { initial: Workspace }) {
  const [ws, setWs] = useState(initial)
  const group = activeGroup(ws)

  return (
    <div className="flex h-screen w-screen bg-editor text-text">
      <aside className="flex w-[264px] flex-none flex-col gap-[3px] overflow-y-auto border-r border-hairline bg-panel p-2">
        <div className="px-1.5 pb-1.5 pt-1 font-mono text-[9.5px] uppercase tracking-[0.4px] text-muted-foreground">
          Sessions — drag one onto another to split
        </div>
        {ws.groups.map((g) =>
          g.panes.length > 1 ? (
            <SplitRow
              key={g.id}
              group={g}
              sessions={FIXTURE}
              active={g.id === ws.activeGroupId}
              onFocusPane={(gid, i) => setWs((w) => focusPane(w, gid, i))}
              onClosePane={(gid, i) => setWs((w) => closePane(w, gid, i))}
              onSeparateAll={(gid) => setWs((w) => separateAll(w, gid))}
              onSplitWith={(gid, sid, at) => setWs((w) => splitWith(w, gid, sid, at))}
              splitCandidates={FIXTURE.filter((s) => !g.panes.some((p) => p.sessionId === s.id))}
            />
          ) : (
            <SessionRow
              key={g.id}
              session={byId(g.panes[0]!.sessionId)}
              active={g.id === ws.activeGroupId}
              onSelect={(id) => setWs((w) => show(w, id))}
            />
          )
        )}
        <div className="mt-2 border-t border-hairline pt-2">
          <div className="px-1.5 pb-1.5 font-mono text-[9.5px] uppercase tracking-[0.4px] text-muted-foreground">
            Not on screen
          </div>
          {FIXTURE.filter((s) => !ws.groups.some((g) => g.panes.some((p) => p.sessionId === s.id))).map(
            (s) => (
              <SessionRow key={s.id} session={s} onSelect={(id) => setWs((w) => show(w, id))} />
            )
          )}
        </div>
      </aside>

      <SplitView
        group={group}
        renderPane={(pane, index) => <PlaceholderPane session={byId(pane.sessionId)} index={index} />}
        onFocusPane={(i) => group && setWs((w) => focusPane(w, group.id, i))}
        onSplitWith={(sessionId, at) => group && setWs((w) => splitWith(w, group.id, sessionId, at))}
        onReplacePane={(index, sessionId) =>
          group && setWs((w) => replacePane(w, group.id, index, sessionId))
        }
        onResize={(index, delta) => group && setWs((w) => resize(w, group.id, index, delta))}
        onAddSplit={() => {
          if (!group) return
          const next = FIXTURE.find((s) => !ws.groups.some((g) => g.panes.some((p) => p.sessionId === s.id)))
          if (next) setWs((w) => splitWith(w, group.id, next.id, group.panes.length))
        }}
        emptyState={
          <div className="flex flex-col items-center gap-2 text-dim">
            <Columns2 size={22} />
            <span className="text-[12px]">Nothing on screen — pick a session</span>
          </div>
        }
      />
    </div>
  )
}

const meta = {
  title: "App/Split",
  component: SplitPlayground,
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof SplitPlayground>

export default meta
type Story = StoryObj<typeof meta>

/** One session, no split. In this model that's a group of one — a plain row. */
export const SinglePane: Story = {
  args: { initial: workspaceOf(["s1"], ["s3"]) }
}

/**
 * Two panes in one group — and, in the sidebar, ONE row with two segments, each
 * with its own status dot, title and close ×. That's Arc's sidebar treatment:
 * "hit the X next to either Split View Tab in the Sidebar to close it".
 */
export const TwoPaneSplit: Story = {
  args: { initial: workspaceOf(["s1", "s2"], ["s3"]) }
}

/** The cap. At four panes the "Add right split" placeholder hides itself. */
export const FourPaneSplit: Story = {
  args: { initial: workspaceOf(["s1", "s2", "s3", "s4"]) },
  parameters: {
    docs: { description: { story: `Arc's maximum is ${MAX_PANES} panes; the model refuses a fifth.` } }
  }
}

/**
 * Drag any sidebar row onto a pane. The outer eighths INSERT a pane on that side
 * (a blue bar marks the edge); the middle REPLACES that pane's session.
 */
export const DragToSplit: Story = {
  args: { initial: workspaceOf(["s1"], ["s2"], ["s3"], ["s4"]) }
}

/**
 * Close a segment's × and the pill re-lays out; close down to one and the pill
 * morphs back into an ordinary row. No empty slot is ever left behind.
 */
export const CloseAPane: Story = {
  args: { initial: workspaceOf(["s1", "s2", "s3"]) }
}

/**
 * Right-click the pill (or use its peek card) for "Separate all tabs" — Arc's
 * own wording, reached the same way. Each session flies out to its own row.
 */
export const SeparateAll: Story = {
  args: { initial: workspaceOf(["s1", "s2", "s3"], ["s4"]) }
}

/** Hover a split row for ~260ms: the peek card spells out what's inside. */
export const PeekCard: Story = {
  args: { initial: workspaceOf(["s1", "s2"], ["s3", "s4"]) }
}

/**
 * The same split with `prefers-reduced-motion` honoured. Panes appear and
 * disappear instantly — nothing slides — while the layout still reads correctly.
 * Driven by the `MotionConfig` decorator in `.storybook/preview.ts`, exactly as
 * `AppShell` drives it in the app.
 */
export const ReducedMotion: Story = {
  args: { initial: workspaceOf(["s1", "s2"], ["s3"]) },
  parameters: {
    docs: {
      description: {
        story:
          "Set your OS to Reduce Motion (macOS: System Settings → Accessibility → Display) and reload to compare."
      }
    }
  }
}

/**
 * The repo field from the New Session dialog, standalone. Type to filter both
 * sections; star a repo without the tap selecting it or closing the menu.
 */
export const RepoPickerWithSearch: StoryObj = {
  render: function RepoPickerStory() {
    const REPOS = [
      "gtm-grid",
      "starbase",
      "trigify-app",
      "athena",
      "avatarz",
      "buffet-line",
      "claude-code",
      "hamburger",
      "spineshatter",
      "wowsims"
    ].map((name) => ({
      name,
      path: `/code/${name}`,
      defaultBranch: "main",
      currentBranch: "main",
      remoteUrl: null,
      githubSlug: null
    }))
    const [value, setValue] = useState("/code/hamburger")
    const [starred, setStarred] = useState<ReadonlyArray<string>>([
      "/code/gtm-grid",
      "/code/starbase",
      "/code/trigify-app"
    ])
    return (
      <div className="w-[420px] rounded-xl border border-line bg-panel p-5">
        <div className="pb-1.5 font-mono text-[9.5px] uppercase tracking-[0.4px] text-muted-foreground">
          Repo
        </div>
        <RepoPicker
          repos={REPOS}
          value={value}
          onChange={setValue}
          starredRepos={starred}
          onToggleStar={(path) =>
            setStarred((current) =>
              current.includes(path) ? current.filter((p) => p !== path) : [...current, path]
            )
          }
        />
      </div>
    )
  }
}
