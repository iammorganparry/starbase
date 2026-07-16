import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { BrowserPreview } from "./browser-preview.js"
import type { DockSide } from "./terminal-panel.js"

const meta = {
  title: "App/BrowserPreview",
  component: BrowserPreview,
  parameters: { layout: "fullscreen" },
  args: {
    dock: "right",
    onDockChange: () => {},
    visible: true,
    onToggle: () => {},
    url: "http://localhost:3000",
    onNavigate: () => {},
    onReload: () => {},
    children: null
  }
} satisfies Meta<typeof BrowserPreview>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Interactive chrome: the native `WebContentsView` isn't available in Storybook,
 * so the body shows a placeholder in its place. Address bar + dock controls work.
 */
export const Default: Story = {
  render: () => {
    const [side, setSide] = useState<DockSide>("right")
    const [url, setUrl] = useState("http://localhost:3000")
    return (
      <div className="flex h-screen bg-editor">
        <div className="flex-1" />
        <BrowserPreview
          dock={side}
          onDockChange={setSide}
          visible
          onToggle={() => {}}
          url={url}
          onNavigate={setUrl}
          onReload={() => {}}
        >
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-dim">
            Native browser view renders here — loading {url}
          </div>
        </BrowserPreview>
      </div>
    )
  }
}
