import type { Meta, StoryObj } from "@storybook/react-vite"
import type { User } from "@starbase/core"
import { UserMenu } from "./user-menu.js"

const meta = {
  title: "Composites/UserMenu",
  component: UserMenu,
  parameters: { layout: "centered" }
} satisfies Meta<typeof UserMenu>

export default meta
type Story = StoryObj<typeof meta>

const user: User = {
  id: "u_1",
  name: "Morgan Parry",
  email: "morgan@trigify.io",
  image: null
}

const noop = () => {}

/** Sits in a mock sidebar footer; click to open the menu (opens upward). */
export const Default: Story = {
  args: {
    user,
    version: "2.43.9",
    ghConnected: true,
    onOpenSettings: noop,
    onOpenUsage: noop,
    onSignOut: noop
  },
  render: (args) => (
    <div className="mt-[320px] w-[266px] rounded-md border border-hairline bg-panel p-1.5">
      <UserMenu {...args} />
    </div>
  )
}

/** Magic-link user with no display name → email is used, monogram avatar. */
export const NoName: Story = {
  args: {
    user: { id: "u_2", name: "", email: "founder@example.com", image: null },
    version: "2.43.9",
    onOpenSettings: noop,
    onOpenUsage: noop,
    onSignOut: noop
  },
  render: (args) => (
    <div className="mt-[320px] w-[266px] rounded-md border border-hairline bg-panel p-1.5">
      <UserMenu {...args} />
    </div>
  )
}
