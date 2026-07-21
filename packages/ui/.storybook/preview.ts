import { createElement } from "react"
import type { Preview } from "@storybook/react-vite"
import { MotionConfig } from "motion/react"
import "../src/globals.css"

const preview: Preview = {
  // Mirrors the `MotionConfig` in `AppShell`, so a component's motion looks the
  // same in Storybook as it does in the app — including the reduced-motion
  // behaviour, which is the whole point of approving these here first.
  // `createElement` rather than JSX because this file is `.ts`.
  decorators: [(Story) => createElement(MotionConfig, { reducedMotion: "user" }, createElement(Story))],
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
