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

/** Which side of the wall we're showing: sign in to an account, or create one. */
export type AuthMode = "signin" | "signup"

export interface LoginScreenProps {
  /** Which state the wall is in (drives loading/sent/error affordances). */
  state?: LoginState
  /** The address a magic link was sent to (shown in the `sent` state). */
  sentEmail?: string
  /** Overrides the default error copy. */
  errorMessage?: string
  onGithub: () => void
  onGoogle: () => void
  /** Request a magic link. `name` is passed only from the sign-up form. */
  onSendMagicLink: (email: string, name?: string) => void
  /** Return from the `sent` state to enter different details. */
  onReset: () => void
}

const COPY: Record<AuthMode, { title: string; subtitle: string }> = {
  signin: { title: "Sign in to Starbase", subtitle: "Run and manage your agent sessions." },
  signup: { title: "Create your account", subtitle: "Start running agent sessions in minutes." }
}

/**
 * The sign-in wall — the whole app is gated behind this. A macOS titlebar over a
 * starfield, with the auth card (GitHub + Google OAuth, a divider, and the email
 * magic-link form). The footer toggles between sign-in and sign-up: sign-up adds
 * a name field and a terms notice, and reframes the copy. Both modes share the
 * same backend flow (magic link / OAuth); sign-up simply carries the display
 * name. Composed from the auth atoms/molecules; states come from `Login.dc.html`.
 * Stateless except for the local mode + input; all actions lifted to props.
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
  const [mode, setMode] = useState<AuthMode>("signin")
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const loading = state === "loading"
  const signup = mode === "signup"

  /** Clear local inputs and any in-flight machine state, then flip modes. */
  const toggleMode = () => {
    setEmail("")
    setName("")
    onReset()
    setMode(signup ? "signin" : "signup")
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar />
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <Starfield />

        <AuthCard title={COPY[mode].title} subtitle={COPY[mode].subtitle}>
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
            <OAuthButton provider="github" mode={mode} onClick={onGithub} disabled={loading} />
            <OAuthButton provider="google" mode={mode} onClick={onGoogle} disabled={loading} />
          </div>

          <AuthDivider />

          <MagicLinkForm
            state={state}
            mode={mode}
            email={email}
            name={name}
            sentEmail={sentEmail}
            onEmailChange={setEmail}
            onNameChange={setName}
            onSubmit={() => onSendMagicLink(email, signup ? name : undefined)}
            onReset={() => {
              setEmail("")
              setName("")
              onReset()
            }}
          />

          {signup ? (
            <p className="mt-2 text-center text-[11px] leading-normal text-dim">
              By continuing you agree to our{" "}
              <a href="#" onClick={(event) => event.preventDefault()} className="text-blue hover:underline">
                Terms
              </a>{" "}
              &amp;{" "}
              <a href="#" onClick={(event) => event.preventDefault()} className="text-blue hover:underline">
                Privacy Policy
              </a>
              .
            </p>
          ) : (
            <a
              href="#"
              onClick={(event) => event.preventDefault()}
              className="mt-2 text-[12px] text-muted-foreground transition-colors hover:text-text"
            >
              Trouble signing in?
            </a>
          )}
        </AuthCard>

        {/* Footer toggles between sign-in and sign-up. */}
        <div className="absolute inset-x-0 bottom-0 z-10 flex h-[42px] items-center justify-center gap-1.5 border-t border-hairline bg-panel text-[12px] text-muted-foreground">
          <span>{signup ? "Already have an account?" : "New to Starbase?"}</span>
          <button
            type="button"
            onClick={toggleMode}
            className="text-blue hover:underline"
          >
            {signup ? "Sign in" : "Create an account"}
          </button>
        </div>
      </div>
    </div>
  )
}
