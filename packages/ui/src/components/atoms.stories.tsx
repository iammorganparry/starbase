import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Attachment } from "@starbase/core"
import { StatusDot } from "./status-dot.js"
import { Badge } from "./badge.js"
import { Pill } from "./pill.js"
import { Toggle } from "./toggle.js"
import { Spinner, Skeleton } from "./loading.js"
import { Avatar } from "./avatar.js"
import { Kbd } from "./kbd.js"
import { AttachmentThumb } from "./attachment-thumb.js"

const meta: Meta = { title: "Atoms/Overview" }
export default meta
type Story = StoryObj

/** A tiny inline PNG so the attachment stories render without external assets. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const sampleImage = (name: string): Attachment => ({
  id: name,
  name,
  mediaType: "image/png",
  data: PNG
})

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

export const AttachmentThumbs: Story = {
  name: "Attachment thumbnails",
  render: () => (
    <div className="flex items-end gap-4 bg-editor p-4">
      {/* Composer tile: 58px square, removable. */}
      <AttachmentThumb attachment={sampleImage("login.png")} onRemove={() => {}} className="size-[58px]" />
      {/* Transcript thumbnail: wider, read-only (no remove). */}
      <AttachmentThumb attachment={sampleImage("screenshot-2026.png")} className="h-[80px] w-[132px]" />
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
