/** 03 · Magic sign-in link — passwordless sign-in. */
import * as React from "react"
import { EmailShell, H1, P, Divider, MetaBox, PrimaryButton, SecurityFooter } from "./components.js"
import { color, font } from "./theme.js"

export interface MagicLinkProps {
  /** One-time sign-in link. */
  signInUrl: string
  /** Optional request context shown in the mono box (device / ip · location). */
  requestMeta?: {
    device: string
    ip: string
  }
}

export const magicLinkSubject = "Your Starbase sign-in link"

export function MagicLink({ signInUrl, requestMeta }: MagicLinkProps) {
  return (
    <EmailShell preview="Tap to sign in — no password needed." footer={<SecurityFooter />}>
      <H1>Sign in to Starbase</H1>
      <P>
        Here&apos;s the magic link you asked for. It signs you in on this device — no password
        required.
      </P>
      <PrimaryButton href={signInUrl}>Sign in to Starbase</PrimaryButton>
      <P
        style={{
          margin: "18px 0 20px",
          fontFamily: font.mono,
          fontSize: "12px",
          color: color.caption
        }}
      >
        ⏱ Expires in 10 minutes · one-time use
      </P>
      {requestMeta ? (
        <MetaBox
          rows={[
            { label: "request", value: requestMeta.device },
            { label: "ip     ", value: requestMeta.ip }
          ]}
        />
      ) : null}
      <Divider />
      <P style={{ margin: 0, fontSize: "12.5px", lineHeight: 1.45, color: color.muted }}>
        Didn&apos;t try to sign in? Ignore this email and your account stays locked.
      </P>
    </EmailShell>
  )
}

MagicLink.PreviewProps = {
  signInUrl: "https://app.starbase.dev/auth/magic?t=af93k2",
  requestMeta: { device: "macOS · Chrome 126", ip: "84.23.·.· · Amsterdam, NL" }
} satisfies MagicLinkProps

export default MagicLink
