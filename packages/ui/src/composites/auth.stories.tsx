import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { AuthDivider } from "../components/auth-divider.js"
import { OAuthButton } from "../components/oauth-button.js"
import { Starfield } from "../components/starfield.js"
import { AuthCard } from "./auth-card.js"
import { MagicLinkForm, type MagicLinkState } from "./magic-link-form.js"

const meta: Meta = { title: "Auth", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="w-[328px] rounded-lg border border-line bg-panel p-6">{children}</div>
)

export const OAuthButtons: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-2">
        <OAuthButton provider="github" onClick={() => {}} />
        <OAuthButton provider="google" onClick={() => {}} />
        <OAuthButton provider="github" disabled />
      </div>
    </Frame>
  )
}

export const OAuthButtonsSignup: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-2">
        <OAuthButton provider="github" mode="signup" onClick={() => {}} />
        <OAuthButton provider="google" mode="signup" onClick={() => {}} />
      </div>
    </Frame>
  )
}

export const Divider: Story = {
  render: () => (
    <Frame>
      <AuthDivider />
    </Frame>
  )
}

export const StarfieldBackdrop: Story = {
  render: () => (
    <div className="relative h-[360px] w-[560px] overflow-hidden rounded-lg border border-line">
      <Starfield />
    </div>
  )
}

/** The magic-link molecule, one story per state. */
const MagicLink = ({
  state,
  mode = "signin"
}: {
  state: MagicLinkState
  mode?: "signin" | "signup"
}) => {
  const [email, setEmail] = useState(state === "sent" ? "" : "founder@example.com")
  const [name, setName] = useState(mode === "signup" ? "Ada Lovelace" : "")
  return (
    <Frame>
      <MagicLinkForm
        state={state}
        mode={mode}
        email={email}
        name={name}
        sentEmail="founder@example.com"
        onEmailChange={setEmail}
        onNameChange={setName}
        onSubmit={() => {}}
        onReset={() => {}}
      />
    </Frame>
  )
}

export const MagicLinkDefault: Story = { render: () => <MagicLink state="default" /> }
export const MagicLinkLoading: Story = { render: () => <MagicLink state="loading" /> }
export const MagicLinkSent: Story = { render: () => <MagicLink state="sent" /> }
export const MagicLinkError: Story = { render: () => <MagicLink state="error" /> }

export const SignupDefault: Story = { render: () => <MagicLink state="default" mode="signup" /> }
export const SignupLoading: Story = { render: () => <MagicLink state="loading" mode="signup" /> }
export const SignupSent: Story = { render: () => <MagicLink state="sent" mode="signup" /> }

export const Card: Story = {
  render: () => (
    <AuthCard title="Sign in to Starbase" subtitle="Run and manage your agent sessions.">
      <OAuthButton provider="github" onClick={() => {}} />
      <AuthDivider />
      <MagicLinkForm
        state="default"
        email=""
        onEmailChange={() => {}}
        onSubmit={() => {}}
        onReset={() => {}}
      />
    </AuthCard>
  )
}
