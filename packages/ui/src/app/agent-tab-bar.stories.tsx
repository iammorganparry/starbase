import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { AgentTabBar, MAIN_AGENT, type AgentTabItem } from "./agent-tab-bar.js"

const meta = {
  title: "App/AgentTabBar",
  component: AgentTabBar
} satisfies Meta<typeof AgentTabBar>

export default meta
type Story = StoryObj<typeof meta>

const AGENTS: ReadonlyArray<AgentTabItem> = [
  {
    id: "t1",
    name: "Explore",
    description: "Map plan approve + stale-plan wiring",
    status: "working",
    hasChildren: false
  },
  {
    id: "t2",
    name: "Explore",
    description: "Map prompt/run resume + re-drive machinery",
    status: "working",
    hasChildren: false
  },
  { id: "t3", name: "general-purpose", description: "Audit the RPC surface", status: "done", hasChildren: false }
]

/** Interactive: click a cell to select it (Main + several live sub-agents). */
export const Interactive: Story = {
  args: { agents: AGENTS, trail: [], active: MAIN_AGENT, onChange: () => {}, onDrill: () => {}, onNavigate: () => {} },
  render: (args) => {
    const [active, setActive] = useState(args.active)
    return (
      <AgentTabBar
        agents={args.agents}
        trail={args.trail}
        active={active}
        onChange={setActive}
        onDrill={setActive}
        onNavigate={setActive}
      />
    )
  }
}

/** A single running sub-agent (the common early-exploration case). */
export const OneWorking: Story = {
  args: {
    agents: [AGENTS[0]!],
    trail: [],
    active: "t1",
    onChange: () => {},
    onDrill: () => {},
    onNavigate: () => {}
  }
}

/** An errored sub-agent alongside a working one. */
export const WithError: Story = {
  args: {
    agents: [
      AGENTS[0]!,
      { id: "t9", name: "Explore", description: "Broke mid-run", status: "error", hasChildren: false }
    ],
    trail: [],
    active: MAIN_AGENT,
    onChange: () => {},
    onDrill: () => {},
    onNavigate: () => {}
  }
}

/**
 * Nested sub-agents — a sub-agent that spawned its own. The flat list below is
 * shaped like the real `Subagent[]` (parent pointers, no nesting); the story
 * derives each level exactly as `ConversationPane` does, so the drill-down and
 * breadcrumb are fully clickable here: drill into "general-purpose" via its `>`.
 */
const TREE: ReadonlyArray<AgentTabItem & { parentId: string | null }> = [
  { id: "t1", name: "Explore", description: "Map the RPC surface", status: "done", parentId: null, hasChildren: false },
  {
    id: "t2",
    name: "general-purpose",
    description: "Adversarial review",
    status: "working",
    parentId: null,
    hasChildren: true
  },
  { id: "t2a", name: "verify:auth", description: "Refute the auth finding", status: "working", parentId: "t2", hasChildren: false },
  {
    id: "t2b",
    name: "verify:rpc",
    description: "Refute the RPC finding",
    status: "done",
    parentId: "t2",
    hasChildren: true
  },
  { id: "t2b1", name: "Explore", description: "Re-read the contract", status: "working", parentId: "t2b", hasChildren: false }
]

export const Nested: Story = {
  args: { agents: [], trail: [], active: MAIN_AGENT, onChange: () => {}, onDrill: () => {}, onNavigate: () => {} },
  render: () => {
    const [active, setActive] = useState<string>(MAIN_AGENT)
    const [level, setLevel] = useState<string>(MAIN_AGENT)

    const agents = TREE.filter((a) => a.parentId === (level === MAIN_AGENT ? null : level))
    const trail: Array<{ id: string; name: string }> = []
    for (let cursor = level; cursor !== MAIN_AGENT; ) {
      const node = TREE.find((a) => a.id === cursor)
      if (!node) break
      trail.unshift({ id: node.id, name: node.name })
      cursor = node.parentId ?? MAIN_AGENT
    }
    const go = (id: string) => {
      setLevel(id)
      setActive(id)
    }
    return (
      <AgentTabBar
        agents={agents}
        trail={trail}
        active={active}
        onChange={setActive}
        onDrill={go}
        onNavigate={go}
      />
    )
  }
}
