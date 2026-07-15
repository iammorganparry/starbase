import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { LoginScreen, type LoginState } from "./login-screen.js"

/**
 * The full sign-in wall. `LoginScreen` owns its sign-in/sign-up mode locally, so
 * these stories only stub the lifted actions — click the footer link to toggle
 * modes and watch the copy, name field, and terms notice swap.
 */
const meta: Meta<typeof LoginScreen> = {
  title: "Auth/LoginScreen",
  component: LoginScreen,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof LoginScreen>

const noop = () => {}

/** Interactive: send fakes the loading→sent transition so both modes are drivable. */
const Interactive = ({ initial = "default" }: { initial?: LoginState }) => {
  const [state, setState] = useState<LoginState>(initial)
  const [sentEmail, setSentEmail] = useState<string>()
  return (
    <div className="h-screen">
      <LoginScreen
        state={state}
        sentEmail={sentEmail}
        onGithub={noop}
        onGoogle={noop}
        onSendMagicLink={(email) => {
          setSentEmail(email)
          setState("loading")
          setTimeout(() => setState("sent"), 900)
        }}
        onReset={() => {
          setState("default")
          setSentEmail(undefined)
        }}
      />
    </div>
  )
}

export const Default: Story = { render: () => <Interactive /> }
export const Error: Story = { render: () => <Interactive initial="error" /> }
export const Sent: Story = { render: () => <Interactive initial="sent" /> }
