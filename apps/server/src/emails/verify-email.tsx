/** 01 · Verify email — confirm the address to finish sign-up. */
import * as React from "react"
import { EmailShell, H1, Mono, P, Divider, PrimaryButton, SecurityFooter } from "./components.js"
import { color, font, radius } from "./theme.js"

export interface VerifyEmailProps {
  /** The address being confirmed. */
  email: string
  /** One-time verification link. */
  verifyUrl: string
}

export const verifyEmailSubject = "Confirm your email to finish signing up"

export function VerifyEmail({ email, verifyUrl }: VerifyEmailProps) {
  return (
    <EmailShell preview="One click and your first session is ready." footer={<SecurityFooter />}>
      <H1>Confirm your email</H1>
      <P>
        Thanks for signing up for Starbase. Confirm <Mono>{email}</Mono> and we&apos;ll drop you
        straight into your workspace.
      </P>
      <PrimaryButton href={verifyUrl}>Verify email address</PrimaryButton>
      <P style={{ margin: "22px 0 8px", fontSize: "12.5px", lineHeight: 1.45, color: color.caption }}>
        This link expires in 24 hours. If the button doesn&apos;t work, paste this into your browser:
      </P>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: "12px",
          color: color.accent,
          wordBreak: "break-all",
          padding: "9px 12px",
          background: color.sunken,
          border: `1px solid ${color.border}`,
          borderRadius: radius.sm
        }}
      >
        {verifyUrl}
      </div>
      <Divider />
      <P style={{ margin: 0, fontSize: "12.5px", lineHeight: 1.45, color: color.muted }}>
        Didn&apos;t sign up? You can safely ignore this email — no account will be created.
      </P>
    </EmailShell>
  )
}

VerifyEmail.PreviewProps = {
  email: "you@acme.dev",
  verifyUrl: "https://app.starbase.dev/verify?t=9f2c8b1e-4a7d-4c2e-9b1a-3f8e2c1d5a1b"
} satisfies VerifyEmailProps

export default VerifyEmail
