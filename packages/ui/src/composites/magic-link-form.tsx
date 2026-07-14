import { Mail, MailCheck } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Input } from "../components/input.js"
import { Spinner } from "../components/loading.js"

export type MagicLinkState = "default" | "loading" | "sent" | "error"

export interface MagicLinkFormProps {
  /** Which visual state to render. `error` shows the form (the banner lives above). */
  state?: MagicLinkState
  /** Controlled email value. */
  email: string
  /** The address a link was sent to (shown in the `sent` confirmation). */
  sentEmail?: string
  onEmailChange: (value: string) => void
  /** Submit the email for a magic link (also fired on Enter). */
  onSubmit: () => void
  /** Return from the `sent` state to re-enter an email. */
  onReset: () => void
}

/**
 * The email magic-link control: an input + submit button that also covers the
 * loading, sent, and error states. A molecule so it can be storybooked in every
 * state independently of the full LoginScreen.
 */
export function MagicLinkForm({
  state = "default",
  email,
  sentEmail,
  onEmailChange,
  onSubmit,
  onReset
}: MagicLinkFormProps) {
  if (state === "sent") {
    return (
      <div className="flex w-full flex-col items-center gap-2.5">
        <Callout tone="green" glyph={<MailCheck className="size-3.5" />}>
          Sign-in link sent to{" "}
          <strong className="font-semibold text-text-bright">{sentEmail || "your email"}</strong>.
        </Callout>
        <button
          type="button"
          onClick={onReset}
          className="text-[12px] text-text transition-colors hover:text-text-bright"
        >
          Use a different email
        </button>
      </div>
    )
  }

  const loading = state === "loading"
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!loading) onSubmit()
      }}
    >
      <Input
        type="email"
        placeholder="you@company.com"
        value={email}
        onChange={(event) => onEmailChange(event.target.value)}
        autoComplete="email"
        aria-label="Email address"
        disabled={loading}
      />
      <Button type="submit" disabled={loading} className="w-full gap-1.5">
        {loading ? <Spinner size={14} /> : <Mail className="size-3.5" />}
        {loading ? "Sending link…" : "Send magic link"}
      </Button>
    </form>
  )
}
