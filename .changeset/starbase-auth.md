---
"@starbase/server": minor
"@starbase/desktop": minor
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/ui": minor
---

Introduce authentication and gate the desktop app behind a sign-in wall.

- New `@starbase/server` auth backend: BetterAuth over Postgres/Drizzle on Hono,
  runnable locally (`@hono/node-server` + Docker Postgres) and deployable to
  Vercel. Supports GitHub OAuth, Google OAuth, and email magic links.
- Desktop `starbase://` deep-link sign-in with the bearer token stored in the OS
  keychain (Electron `safeStorage`), a new `AuthService` + `Auth.*` RPCs, and a
  dedicated `authMachine` that gates the whole app until signed in.
- New sign-in UI: `LoginScreen` plus reusable `OAuthButton`, `AuthDivider`,
  `Starfield`, `MagicLinkForm`, and `AuthCard` components.
