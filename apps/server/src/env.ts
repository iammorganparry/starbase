/**
 * Central environment access for the auth server. Read once at module load.
 *
 * Dev-friendly defaults keep the server bootable with zero configuration (Docker
 * Postgres + console magic links). Production MUST set the real secrets — the
 * defaults here are intentionally insecure so a misconfigured prod deploy is
 * obvious rather than silently "working".
 */
const optional = (key: string, fallback = ""): string => process.env[key] ?? fallback

const nodeEnv = optional("NODE_ENV", "development")

export const env = {
  nodeEnv,
  isDev: nodeEnv !== "production",
  port: Number(optional("PORT", "9100")),
  /** Postgres connection string. Defaults to the local Docker instance (port 5433). */
  databaseUrl: optional("DATABASE_URL", "postgres://postgres:postgres@localhost:5433/starbase"),
  /** BetterAuth signing secret. MUST be overridden in production. */
  authSecret: optional("BETTER_AUTH_SECRET", "dev-insecure-secret-change-me"),
  /** Public base URL the auth server is reachable at (used for OAuth callbacks). */
  authBaseUrl: optional("BETTER_AUTH_URL", "http://localhost:9100"),
  githubClientId: optional("GITHUB_CLIENT_ID"),
  githubClientSecret: optional("GITHUB_CLIENT_SECRET"),
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  resendApiKey: optional("RESEND_API_KEY"),
  emailFrom: optional("EMAIL_FROM", "Starbase <login@starbase.local>"),
  /** Deep-link the desktop app registers; magic links + OAuth bounce back here. */
  desktopRedirect: optional("DESKTOP_REDIRECT", "starbase://auth/callback")
} as const

/** True when a social provider has both id + secret configured (else we skip it). */
export const hasGithub = Boolean(env.githubClientId && env.githubClientSecret)
export const hasGoogle = Boolean(env.googleClientId && env.googleClientSecret)
