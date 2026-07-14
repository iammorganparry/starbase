import { useState } from "react"
import { AlertCircle } from "lucide-react"
import { TitleBar } from "../app/title-bar.js"
import { AuthDivider } from "../components/auth-divider.js"
import { Callout } from "../components/callout.js"
import { OAuthButton } from "../components/oauth-button.js"
import { Starfield } from "../components/starfield.js"
import { AuthCard } from "../composites/auth-card.js"
import { MagicLinkForm } from "../composites/magic-link-form.js"

export type LoginState = "default" | "loading" | "sent" | "error"

export interface LoginScreenProps {
  /** Which state the wall is in (drives loading/sent/error affordances). */
  state?: LoginState
  /** The address a magic link was sent to (shown in the `sent` state). */
  sentEmail?: string
  /** Overrides the default error copy. */
  errorMessage?: string
  onGithub: () => void
  onGoogle: () => void
  onSendMagicLink: (email: string) => void
  /** Return from the `sent` state to enter a different email. */
  onReset: () => void
}

/**
 * The sign-in wall — the whole app is gated behind this. A macOS titlebar over a
 * starfield, with the sign-in card (GitHub + Google OAuth, a divider, and the
 * email magic-link form). Composed entirely from the auth atoms/molecules; the
 * four states come straight from `Login.dc.html`. Stateless except for the local
 * email input; all actions are lifted to props for the auth state machine.
 */
export function LoginScreen({
  state = "default",
  sentEmail,
  errorMessage,
  onGithub,
  onGoogle,
  onSendMagicLink,
  onReset
}: LoginScreenProps) {
  const [email, setEmail] = useState("")
  const loading = state === "loading"

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar />
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <Starfield />

        <AuthCard title="Sign in to Starbase" subtitle="Run and manage your agent sessions.">
          {state === "error" ? (
            <Callout tone="red" glyph={<AlertCircle className="size-3.5" />} className="w-full">
              {errorMessage ?? "We couldn't sign you in. Please try again."}
            </Callout>
          ) : null}

          {/* OAuth stays visible across states; only the form area swaps to `sent`. */}
          <div
            className="flex w-full flex-col gap-2"
            style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? "none" : "auto" }}
          >
            <OAuthButton provider="github" onClick={onGithub} disabled={loading} />
            <OAuthButton provider="google" onClick={onGoogle} disabled={loading} />
          </div>

          <AuthDivider />

          <MagicLinkForm
            state={state}
            email={email}
            sentEmail={sentEmail}
            onEmailChange={setEmail}
            onSubmit={() => onSendMagicLink(email)}
            onReset={() => {
              setEmail("")
              onReset()
            }}
          />

          <a
            href="#"
            onClick={(event) => event.preventDefault()}
            className="mt-2 text-[12px] text-muted-foreground transition-colors hover:text-text"
          >
            Trouble signing in?
          </a>
        </AuthCard>

        {/* Footer sign-up prompt. */}
        <div className="absolute inset-x-0 bottom-0 z-10 flex h-[42px] items-center justify-center gap-1.5 border-t border-hairline bg-panel text-[12px] text-muted-foreground">
          <span>New to Starbase?</span>
          <a
            href="#"
            onClick={(event) => event.preventDefault()}
            className="text-blue hover:underline"
          >
            Create an account
          </a>
        </div>
      </div>
    </div>
  )
}
