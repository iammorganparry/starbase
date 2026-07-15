/**
 * Render entrypoint for the email suite. Each helper renders a React Email
 * template to both HTML and a plaintext alternative, paired with its subject, so
 * the sender (`email.ts`) stays a thin Resend wrapper. Templates are the source
 * of truth for copy + subject; callers only supply data.
 */
import * as React from "react"
import { render } from "@react-email/render"
import { MagicLink, magicLinkSubject, type MagicLinkProps } from "./magic-link.js"
import { PasswordChanged, passwordChangedSubject, type PasswordChangedProps } from "./password-changed.js"
import { ResetPassword, resetPasswordSubject, type ResetPasswordProps } from "./reset-password.js"
import { TeamInvite, teamInviteSubject, type TeamInviteProps } from "./team-invite.js"
import { VerifyEmail, verifyEmailSubject, type VerifyEmailProps } from "./verify-email.js"
import { Welcome, welcomeSubject, type WelcomeProps } from "./welcome.js"

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

async function renderEmail(el: React.ReactElement, subject: string): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })])
  return { subject, html, text }
}

export const renderMagicLink = (p: MagicLinkProps): Promise<RenderedEmail> =>
  renderEmail(<MagicLink {...p} />, magicLinkSubject)

export const renderWelcome = (p: WelcomeProps): Promise<RenderedEmail> =>
  renderEmail(<Welcome {...p} />, welcomeSubject)

export const renderVerifyEmail = (p: VerifyEmailProps): Promise<RenderedEmail> =>
  renderEmail(<VerifyEmail {...p} />, verifyEmailSubject)

export const renderResetPassword = (p: ResetPasswordProps): Promise<RenderedEmail> =>
  renderEmail(<ResetPassword {...p} />, resetPasswordSubject)

export const renderPasswordChanged = (p: PasswordChangedProps): Promise<RenderedEmail> =>
  renderEmail(<PasswordChanged {...p} />, passwordChangedSubject)

export const renderTeamInvite = (p: TeamInviteProps): Promise<RenderedEmail> =>
  renderEmail(<TeamInvite {...p} />, teamInviteSubject(p.inviterName, p.teamName))

export type {
  MagicLinkProps,
  WelcomeProps,
  VerifyEmailProps,
  ResetPasswordProps,
  PasswordChangedProps,
  TeamInviteProps
}
