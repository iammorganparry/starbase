/**
 * BetterAuth configuration — the chosen methods only: GitHub OAuth, Google
 * OAuth, and email magic link. The `bearer` plugin lets the desktop client
 * authenticate with a token (held in the OS keychain) instead of a browser
 * cookie. Social providers are registered only when their credentials are
 * present, so dev works with just magic links.
 */
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer, magicLink } from "better-auth/plugins"
import { db } from "./db/client.js"
import { schema } from "./db/schema.js"
import { env, hasGithub, hasGoogle } from "./env.js"
import { sendLoginEmail } from "./email.js"

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}
if (hasGithub) {
  socialProviders.github = { clientId: env.githubClientId, clientSecret: env.githubClientSecret }
}
if (hasGoogle) {
  socialProviders.google = { clientId: env.googleClientId, clientSecret: env.googleClientSecret }
}

export const auth = betterAuth({
  secret: env.authSecret,
  baseURL: env.authBaseUrl,
  // The desktop app lives behind a custom protocol; allow it as a redirect target.
  trustedOrigins: ["starbase://"],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  socialProviders,
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendLoginEmail(email, url)
      }
    }),
    bearer()
  ]
})

export type Auth = typeof auth
