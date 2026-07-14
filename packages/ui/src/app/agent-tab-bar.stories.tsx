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
  { id: "t1", name: "Explore", description: "Map plan approve + stale-plan wiring", status: "working" },
  { id: "t2", name: "Explore", description: "Map prompt/run resume + re-drive machinery", status: "working" },
  { id: "t3", name: "general-purpose", description: "Audit the RPC surface", status: "done" }
]

/** Interactive: click a cell to select it (Main + several live sub-agents). */
export const Interactive: Story = {
  args: { agents: AGENTS, active: MAIN_AGENT, onChange: () => {} },
  render: (args) => {
    const [active, setActive] = useState(args.active)
    return <AgentTabBar agents={args.agents} active={active} onChange={setActive} />
  }
}

/** A single running sub-agent (the common early-exploration case). */
export const OneWorking: Story = {
  args: {
    agents: [AGENTS[0]!],
    active: "t1",
    onChange: () => {}
  }
}

/** An errored sub-agent alongside a working one. */
export const WithError: Story = {
  args: {
    agents: [AGENTS[0]!, { id: "t9", name: "Explore", description: "Broke mid-run", status: "error" }],
    active: MAIN_AGENT,
    onChange: () => {}
  }
}
