import type { Preview } from "@storybook/react-vite"
import "../src/globals.css"

const preview: Preview = {
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "canvas",
      values: [
        { name: "canvas", value: "#16181d" },
        { name: "editor", value: "#282c34" },
        { name: "panel", value: "#21252b" }
      ]
    },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    a11y: { test: "todo" }
  }
}

export default preview
