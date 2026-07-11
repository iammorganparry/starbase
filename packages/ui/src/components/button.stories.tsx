import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "./button.js"
import { Kbd } from "./kbd.js"

const meta = {
  title: "Atoms/Button",
  component: Button,
  args: { children: "Primary" },
  argTypes: {
    variant: { control: "select", options: ["primary", "secondary", "danger", "ghost"] },
    size: { control: "select", options: ["sm", "md", "icon"] }
  }
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = { args: { variant: "primary" } }
export const Secondary: Story = { args: { variant: "secondary", children: "Secondary" } }
export const Danger: Story = { args: { variant: "danger", children: "Danger" } }
export const Ghost: Story = { args: { variant: "ghost", children: "Ghost" } }

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button>
        Primary <Kbd onFill>↵</Kbd>
      </Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="ghost">Ghost</Button>
    </div>
  )
}
