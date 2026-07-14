/**
 * Transactional email for magic links. In dev (no RESEND_API_KEY) the link is
 * logged to the console so the whole flow works fully offline. In prod a Resend
 * key sends a real email.
 */
import { Resend } from "resend"
import { env } from "./env.js"

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null

export const sendLoginEmail = async (email: string, url: string): Promise<void> => {
  if (!resend) {
    // eslint-disable-next-line no-console
    console.log(`\n[@starbase/server] magic-link for ${email}:\n  ${url}\n`)
    return
  }
  await resend.emails.send({
    from: env.emailFrom,
    to: email,
    subject: "Your Starbase sign-in link",
    html: [
      `<p>Click to sign in to Starbase:</p>`,
      `<p><a href="${url}">Sign in to Starbase</a></p>`,
      `<p>This link expires shortly. If you didn't request it, you can ignore this email.</p>`
    ].join("")
  })
}
