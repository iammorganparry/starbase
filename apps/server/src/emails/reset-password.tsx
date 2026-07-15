/** 04 · Reset password — start a password reset. */
import * as React from "react"
import { EmailShell, H1, Mono, P, Divider, PrimaryButton, SecurityFooter } from "./components.js"
import { color } from "./theme.js"

export interface ResetPasswordProps {
  /** The account whose password is being reset. */
  email: string
  /** One-time reset link. */
  resetUrl: string
  /** "Secure your account" link for the didn't-request case. */
  secureUrl: string
}

export const resetPasswordSubject = "Reset your Starbase password"

export function ResetPassword({ email, resetUrl, secureUrl }: ResetPasswordProps) {
  return (
    <EmailShell preview="The link is good for 60 minutes." footer={<SecurityFooter />}>
      <H1>Reset your password</H1>
      <P>
        We got a request to reset the password for <Mono>{email}</Mono>. Pick a new one here:
      </P>
      <PrimaryButton href={resetUrl}>Choose a new password</PrimaryButton>
      <P style={{ margin: "22px 0 0", fontSize: "12.5px", lineHeight: 1.45, color: color.caption }}>
        This link expires in 60 minutes and can only be used once.
      </P>
      <Divider />
      <P style={{ margin: 0, fontSize: "12.5px", lineHeight: 1.45, color: color.muted }}>
        Didn&apos;t request this? Your password hasn&apos;t changed — you can ignore this email, or{" "}
        <a href={secureUrl} style={{ color: color.link, textDecoration: "none" }}>
          secure your account
        </a>
        .
      </P>
    </EmailShell>
  )
}

ResetPassword.PreviewProps = {
  email: "you@acme.dev",
  resetUrl: "https://app.starbase.dev/reset?t=7c1a9f",
  secureUrl: "https://app.starbase.dev/security"
} satisfies ResetPasswordProps

export default ResetPassword
