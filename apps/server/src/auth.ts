/**
 * BetterAuth configuration. Sign-in methods: GitHub OAuth, Google OAuth, email
 * magic link, and email + password. The `bearer` plugin lets the desktop client
 * authenticate with a token (held in the OS keychain) instead of a browser
 * cookie. Social providers are registered only when their credentials are
 * present, so dev works with just magic links.
 *
 * Every user-facing email routes through the React Email suite (`./email.js`):
 * magic link, welcome (on account creation), email verification, password reset,
 * and the post-reset security notification.
 */
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer, magicLink, organization } from "better-auth/plugins"
import { db } from "./db/client.js"
import { schema } from "./db/schema.js"
import { env, hasGithub, hasGoogle } from "./env.js"
import {
  sendLoginEmail,
  sendPasswordChangedEmail,
  sendResetPasswordEmail,
  sendTeamInviteEmail,
  sendVerifyEmail,
  sendWelcomeEmail
} from "./email.js"

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}
if (hasGithub) {
  socialProviders.github = { clientId: env.githubClientId, clientSecret: env.githubClientSecret }
}
if (hasGoogle) {
  socialProviders.google = { clientId: env.googleClientId, clientSecret: env.googleClientSecret }
}

/** Short "macOS · Chrome" device label from a request's User-Agent (best-effort). */
function deviceFrom(request?: Request): string {
  const ua = request?.headers.get("user-agent") ?? ""
  if (!ua) return "Unknown device"
  const os = /Mac OS X/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /(iPhone|iPad|iOS)/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS"
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "browser"
  return `${os} · ${browser}`
}

export const auth = betterAuth({
  secret: env.authSecret,
  baseURL: env.authBaseUrl,
  // The desktop app lives behind a custom protocol; allow it as a redirect target.
  trustedOrigins: ["starbase://"],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  socialProviders,
  // Email + password. Sign-up requires verifying the address first; the reset
  // flow emails a link, then confirms the change with a security notification.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    resetPasswordTokenExpiresIn: 60 * 60, // 60 minutes (matches the email copy)
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail(user.email, url)
    },
    onPasswordReset: async ({ user }, request) => {
      // Best-effort — the reset already succeeded; a failed notice mustn't undo it.
      try {
        await sendPasswordChangedEmail(user.email, { device: deviceFrom(request) })
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[@starbase/server] password-changed email failed for ${user.email}:`, error)
      }
    }
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerifyEmail(user.email, url)
    }
  },
  // A new user row is created on first successful sign-in (OAuth, or the first
  // magic-link verification). Greet them once, here — best-effort so a mail
  // hiccup never blocks account creation.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await sendWelcomeEmail(user.email)
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`[@starbase/server] welcome email failed for ${user.email}:`, error)
          }
        }
      }
    }
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendLoginEmail(email, url)
      }
    }),
    organization({
      // Teams stay disabled — orgs + members + invitations only.
      sendInvitationEmail: async (data) => {
        // No dedicated web app yet; point the accept link at the API's own
        // callback surface so the invite id round-trips.
        const acceptUrl = `${env.authBaseUrl}/accept-invitation/${data.id}`
        await sendTeamInviteEmail(data.email, {
          inviterName: data.inviter.user.name || data.inviter.user.email,
          inviterEmail: data.inviter.user.email,
          teamName: data.organization.name,
          role: data.role,
          acceptUrl
        })
      }
    }),
    bearer()
  ]
})

export type Auth = typeof auth
