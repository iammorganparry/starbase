/**
 * Transactional email delivery via Resend, rendered from the React Email suite
 * (`./emails`). In dev (no RESEND_API_KEY) the rendered plaintext — including any
 * action link — is logged to the console so the whole flow works fully offline.
 * In prod a Resend key sends the real, styled HTML email.
 */
import { Resend } from "resend"
import { env } from "./env.js"
import {
  renderMagicLink,
  renderPasswordChanged,
  renderResetPassword,
  renderTeamInvite,
  renderVerifyEmail,
  renderWelcome,
  type RenderedEmail
} from "./emails/index.js"

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null

/** Where the "Open Starbase" CTA points (the app registers the deep link). */
const APP_OPEN_URL = "starbase://open"
const QUICKSTART_URL = "https://starbase.dev/quickstart"
/** Account-security landing page (used by the "secure your account" links). */
const SECURITY_URL = "https://starbase.dev/account/security"

/** Best-effort security context for the "password changed" notification. */
export interface SecurityContext {
  when?: string
  device?: string
  location?: string
}

/** Send a pre-rendered email, or log it to the console when Resend isn't configured. */
async function deliver(to: string, email: RenderedEmail): Promise<void> {
  if (!resend) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[@starbase/server] email "${email.subject}" → ${to} (no RESEND_API_KEY; not sent)\n${email.text}\n`
    )
    return
  }
  await resend.emails.send({
    from: env.emailFrom,
    to,
    subject: email.subject,
    html: email.html,
    text: email.text
  })
}

/** Magic sign-in link (BetterAuth magic-link plugin hook). */
export const sendLoginEmail = async (email: string, url: string): Promise<void> => {
  await deliver(email, await renderMagicLink({ signInUrl: url }))
}

/** Welcome email, sent once the account is created (first sign-in). Best-effort. */
export const sendWelcomeEmail = async (email: string): Promise<void> => {
  await deliver(
    email,
    await renderWelcome({ email, openUrl: APP_OPEN_URL, quickstartUrl: QUICKSTART_URL })
  )
}

/** Email-verification link (email/password sign-up + resend-verification). */
export const sendVerifyEmail = async (email: string, url: string): Promise<void> => {
  await deliver(email, await renderVerifyEmail({ email, verifyUrl: url }))
}

/** Password-reset link (forgot-password flow). */
export const sendResetPasswordEmail = async (email: string, url: string): Promise<void> => {
  await deliver(email, await renderResetPassword({ email, resetUrl: url, secureUrl: SECURITY_URL }))
}

/** Security notification sent after a password is reset/changed. */
export const sendPasswordChangedEmail = async (
  email: string,
  ctx: SecurityContext = {}
): Promise<void> => {
  await deliver(
    email,
    await renderPasswordChanged({
      email,
      when: ctx.when ?? `${new Date().toISOString().slice(0, 16).replace("T", " · ")} UTC`,
      device: ctx.device ?? "Unknown device",
      location: ctx.location ?? "Unknown location",
      secureUrl: SECURITY_URL
    })
  )
}

/** Details for a workspace invitation email (from the organization plugin hook). */
export interface TeamInviteContext {
  inviterName: string
  inviterEmail: string
  teamName: string
  role: string
  acceptUrl: string
}

/** Workspace invite (BetterAuth organization plugin `sendInvitationEmail`). */
export const sendTeamInviteEmail = async (
  email: string,
  ctx: TeamInviteContext
): Promise<void> => {
  await deliver(
    email,
    await renderTeamInvite({
      email,
      inviterName: ctx.inviterName,
      inviterEmail: ctx.inviterEmail,
      teamName: ctx.teamName,
      teamInitial: (ctx.teamName.trim()[0] ?? "?").toUpperCase(),
      roster: "Shared agent workspace",
      role: ctx.role,
      acceptUrl: ctx.acceptUrl
    })
  )
}
