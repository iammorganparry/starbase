import type { Meta, StoryObj } from "@storybook/react-vite"
import { HtmlPreview } from "./html-preview.js"

const SAMPLE = `<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 24px;">
    <h1 style="color:#61afef;">Hello from the agent</h1>
    <p>This HTML block renders in a <strong>sandboxed</strong> iframe.</p>
    <button onclick="document.body.append('clicked!')">Try me (needs scripts)</button>
  </body>
</html>`

const meta = {
  title: "Components/HtmlPreview",
  component: HtmlPreview,
  args: { code: SAMPLE },
  parameters: { layout: "padded" }
} satisfies Meta<typeof HtmlPreview>

export default meta
type Story = StoryObj<typeof meta>

/** Defaults to the raw Code view — the transcript stays plain text until opted in. */
export const Default: Story = {}

/** A minimal snippet, to show the Code/Preview toggle on small content. */
export const Snippet: Story = {
  args: { code: `<p>Just a <em>little</em> markup with a <a href="#">link</a>.</p>` }
}
