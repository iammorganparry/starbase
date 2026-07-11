import type { Meta, StoryObj } from "@storybook/react-vite"
import { LoadingScreen } from "./loading-screen.js"

const meta: Meta<typeof LoadingScreen> = {
  title: "Loading",
  component: LoadingScreen,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof LoadingScreen>

/** The rocket-launch boot splash — fuels, lifts off, and loops. */
export const Launch: Story = {
  render: () => (
    <div className="h-screen w-full">
      <LoadingScreen />
    </div>
  )
}
