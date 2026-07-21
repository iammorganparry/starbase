import type { Meta, StoryObj } from "@storybook/react-vite"
import { BOUNDARY_WIDTHS, LookFor, WidthLadder } from "../story-support.js"
import { TabBar, type TabKey } from "./tab-bar.js"

const meta: Meta = { title: "Responsive/Tab Bar", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const ALL_TABS: ReadonlyArray<TabKey> = ["conversation", "issue", "plan", "pr", "review"]

const noop = () => {}

/** Every control the bar can hold, so the ladder shows the worst case. */
const loaded = {
  tabs: ALL_TABS,
  active: "review" as TabKey,
  onChange: noop,
  prNumber: 482,
  changes: { added: 313, removed: 23 },
  status: { label: "Running", tone: "yellow" as const, detail: "Running pnpm test -- auth" },
  onToggleSplit: noop,
  splitActive: false,
  onToggleBrowser: noop,
  browserActive: false,
  onClosePane: noop,
  onMovePaneLeft: noop,
  onMovePaneRight: noop
}

/**
 * The full bar — five tabs, a PR badge, a diff stat, a status pill and six pane
 * controls — as the pane narrows.
 *
 * This row's min-content width was roughly 970px, inside a pane the split model
 * will happily make 350px. It had no `min-w-0` and no scroll, so the surplus was
 * clipped by the pane rather than degrading — and because the right-hand cluster
 * was `flex-1`, the CLOSE button was the first thing to disappear.
 */
export const Ladder: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> at 1240 every label shows. At 720
        only the active tab (Code Review) keeps its text; the rest are icons with tooltips. At 500
        the six pane controls collapse into a single <code>⋯</code> button — but the ✕ stays. At 380
        the tab strip scrolls horizontally rather than spilling past the dashed outline. Nothing
        should ever cross that outline.
      </LookFor>
      <WidthLadder height={80} render={() => <TabBar {...loaded} />} />
    </div>
  )
}

/**
 * The exact tier boundaries, in pairs.
 *
 * A layout that switches at 780 and 560 has four places it can be wrong by one
 * pixel, and every one of them shows up as a flicker while dragging a divider.
 * Each pair below should look identical apart from the one thing that changed.
 */
export const Boundaries: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> exactly one difference per pair.
        780/779 = labels off. 560/559 = pane controls fold into the menu and the status pill goes.
        400/399 = nothing here, the tab bar treats narrow and tiny alike.
      </LookFor>
      <WidthLadder widths={BOUNDARY_WIDTHS} height={80} render={() => <TabBar {...loaded} />} />
    </div>
  )
}

/**
 * A pane in a split: the identity chip is present and the title is long.
 *
 * The chip is `flex-none`, so a long session title used to push the tabs out of
 * the row entirely. It now truncates at 170px, tightening to 86px below `mid`.
 */
export const WithPaneChip: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the chip truncating rather than
        growing, and the tab strip still reaching its first tab at every width.
      </LookFor>
      <WidthLadder
        height={80}
        render={() => (
          <TabBar
            {...loaded}
            pane={{ index: 1, title: "Refactor the auth middleware and token store", focused: true }}
          />
        )}
      />
    </div>
  )
}

/**
 * A single-pane session with nothing to collapse.
 *
 * The overflow menu must NOT appear here — a `⋯` button that opens onto an empty
 * menu is worse than no button.
 */
export const NothingToCollapse: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> no <code>⋯</code> button at any
        width, because there are no pane actions to put in it.
      </LookFor>
      <WidthLadder
        height={80}
        render={() => <TabBar tabs={["conversation", "pr"]} active="conversation" onChange={noop} />}
      />
    </div>
  )
}
