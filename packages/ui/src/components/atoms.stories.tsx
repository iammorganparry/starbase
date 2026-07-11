import type { Meta, StoryObj } from "@storybook/react-vite"
import { StatusDot } from "./status-dot.js"
import { Badge } from "./badge.js"
import { Pill } from "./pill.js"
import { Toggle } from "./toggle.js"
import { Spinner, Skeleton } from "./loading.js"
import { Avatar } from "./avatar.js"
import { Kbd } from "./kbd.js"

const meta: Meta = { title: "Atoms/Overview" }
export default meta
type Story = StoryObj

export const StatusDots: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-[12px] text-muted-foreground">
      <span className="flex items-center gap-2"><StatusDot status="thinking" /> thinking</span>
      <span className="flex items-center gap-2"><StatusDot status="needs-input" /> needs input</span>
      <span className="flex items-center gap-2"><StatusDot status="done" /> success</span>
      <span className="flex items-center gap-2"><StatusDot tone="bg-red" glow={false} /> error</span>
      <span className="flex items-center gap-2"><StatusDot status="idle" /> idle</span>
    </div>
  )
}

export const Badges: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="count" size="xs">count 4</Badge>
      <Badge tone="blue">blue</Badge>
      <Badge tone="green">green</Badge>
      <Badge tone="yellow">yellow</Badge>
      <Badge tone="red">red</Badge>
      <Badge tone="purple">purple</Badge>
      <Badge tone="cyan">cyan</Badge>
    </div>
  )
}

export const Pills: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Pill tone="yellow" pulse>Running</Pill>
      <Pill tone="green">Connected</Pill>
      <Pill tone="blue" dot={false}>Awaiting</Pill>
      <Pill tone="red">Error</Pill>
    </div>
  )
}

export const Toggles: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Toggle defaultChecked />
      <Toggle />
    </div>
  )
}

export const Loading: Story = {
  render: () => (
    <div className="flex w-64 items-center gap-4">
      <Spinner />
      <Skeleton className="flex-1" />
    </div>
  )
}

export const Avatars: Story = {
  render: () => (
    <div className="flex items-center gap-2.5">
      <Avatar initial="C" tone="blue" />
      <Avatar initial="D" tone="orange" />
      <Avatar initial="Y" tone="dim" />
    </div>
  )
}

export const Kbds: Story = {
  render: () => (
    <div className="flex flex-wrap gap-1.5">
      <Kbd>⌘K</Kbd>
      <Kbd>↵</Kbd>
      <Kbd>esc</Kbd>
      <Kbd onFill>⌥↵</Kbd>
    </div>
  )
}
