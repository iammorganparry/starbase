# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Starbase is a desktop **agent harness**: an Electron app that runs local coding agents (`claude`, `codex`, `cursor`) as parallel **sessions**, each wired to a repo, a git **worktree**, a branch, and a PR. A separate Hono/Postgres **auth backend** (`apps/server`) gates the app behind sign-in. It's a Turborepo monorepo managed with pnpm.

## Commands

Requires Node ≥22 and pnpm 10.7.0. Run from the repo root unless noted.

```bash
pnpm dev            # turbo run dev — starts all apps (electron-vite + server watch)
pnpm build          # turbo run build
pnpm typecheck      # tsc --noEmit across every package (what CI runs)
pnpm test           # vitest run — every package's suite in one pass (what CI runs)
pnpm lint           # turbo run lint (no lint tasks defined yet — currently a no-op)
```

Per-app / per-package (use `--filter`, or `pnpm -C <dir>`):

```bash
pnpm --filter @starbase/desktop dev        # just the Electron app (opens a window)
pnpm --filter @starbase/server dev         # just the auth backend (http://localhost:9100)
pnpm --filter @starbase/ui storybook       # component library preview on :6006
```

Tests (Vitest, configured at the root via the `projects` feature):

```bash
pnpm vitest run path/to/file.test.ts       # a single test file
pnpm vitest run -t "substring of test name" # tests matching a name
pnpm --filter @starbase/server test        # one package's suite
pnpm --filter @starbase/server test:integration  # DB tests (sets STARBASE_DB_TESTS=1)
pnpm --filter @starbase/desktop e2e        # Playwright `_electron` e2e (local only; not in CI)
```

Auth backend needs a local Postgres (Docker, port **5433** to avoid clashing with a host 5432):

```bash
docker compose up -d db                     # start Postgres
pnpm --filter @starbase/server db:generate  # drizzle-kit generate (after schema.ts changes)
pnpm --filter @starbase/server db:migrate   # apply migrations
pnpm --filter @starbase/server db:studio    # drizzle studio
```

Copy `apps/server/.env.example` → `apps/server/.env` for local dev; the server boots with zero real secrets (Docker Postgres + magic links logged to the console when `RESEND_API_KEY` is unset).

## Architecture

### Monorepo layout

- `apps/desktop` — the Electron app (`@starbase/desktop`), built with **electron-vite**.
- `apps/server` — the **BetterAuth** backend (`@starbase/server`) on Hono + Postgres/Drizzle; runs locally via `tsx` and deploys to Vercel (`api/[[...route]].ts`).
- `packages/core` — domain types and errors, expressed as **Effect `Schema`** (`CliKind`, `Session`, `AuthSession`, tagged errors). No runtime logic.
- `packages/contracts` — the **RPC contract** (`StarbaseRpcs`, an `@effect/rpc` `RpcGroup`). The single source of truth for every desktop main↔renderer call.
- `packages/cli-adapters` — the desktop **backend logic** as **Effect services** (`Effect.Service`): `SessionStore`, `AgentRunner`, `WorkspaceService` (git/worktrees), `TerminalService`, `GhService`, `AuthService`, `DiscoveryService`, etc. These run in the Electron **main** process.
- `packages/ui` — React component library (Tailwind, **One Dark Pro** palette, Storybook). Consumed by the renderer.
- `packages/tsconfig` — shared tsconfig presets: `base.json`, `node.json`, `react.json` (the last adds `jsx` + DOM/React types).

### Workspace packages ship raw TypeScript (important)

`@starbase/*` packages set `exports` → `./src/index.ts` — **no build step**. Consumers transpile them:
- the desktop **bundles** them via Vite (they're listed in `electron.vite.config.ts` and *excluded* from `externalizeDepsPlugin`, so main/preload/renderer get them transpiled in);
- the server runs them through `tsx`.

Consequence: editing a package is picked up immediately in dev (no rebuild), and you rarely need `pnpm build` while developing.

### Desktop: three processes + a typed RPC bridge

The Electron app is **main / preload / renderer**. Instead of ad-hoc IPC, it runs the real `@effect/rpc` machinery over one IPC channel:
- `main` hosts an `RpcServer` (`src/main/rpc.ts`) backed by the cli-adapters Effect services, assembled in `src/main/runtime.ts` as a `ManagedRuntime` (`AppLayer` wires every service + `AppPathsLive` + `SecretStore`).
- `renderer` hosts an `RpcClient` (`src/renderer/rpc-client.ts`) exposing plain typed Promises (`rpc.authSendMagicLink(...)`, etc.).
- Both are driven by the shared `StarbaseRpcs` group in `packages/contracts`, which owns every payload/success/error schema. **To add or change a main↔renderer call, edit `packages/contracts` first**, then the main handler and the renderer client.

Renderer UI state is driven by **XState** machines (e.g. `authMachine`, `appMachine`); the app is gated on `authMachine` reaching `signedIn`.

### Persistence

Desktop state is **JSON files under `~/starbase`** (no ORM) — see `apps/desktop/src/main/app-paths.ts`: `config.json`, `sessions.json`, `worktrees/`, `transcripts/`, `.starbase/` (plans), `auth.enc` (the bearer token via `SecretStore`). **`STARBASE_HOME` overrides the root** — the e2e suite points it at a throwaway dir so tests never touch the developer's real `~/starbase`. The auth server's own state lives in **Postgres** (Drizzle schema in `apps/server/src/db/schema.ts`), separate from the desktop's JSON store.

### Auth flow

`apps/server` (BetterAuth: GitHub/Google OAuth + email magic link, `bearer` plugin) issues a token the desktop stores via `SecretStore`. The renderer drives sign-in through the `Auth.*` RPCs → `AuthService` (`packages/cli-adapters/src/auth.ts`), which talks to the backend. OAuth/magic-link bounce back through the `starbase://` custom-protocol deep link, handled in `apps/desktop/src/main/deep-link.ts`. The desktop targets `http://localhost:9100` by default (override with `STARBASE_AUTH_URL`).

## Conventions & gotchas

- **Effect-TS is the backend idiom.** cli-adapters services are `Effect.Service` with `accessors: true`; errors are `Schema.TaggedError` so they encode across the RPC boundary. Prefer Effect over raw async in that layer.
- **Git hooks auto-sync deps.** `prepare` sets `core.hooksPath .githooks`; `post-checkout`/`post-merge` run `pnpm install` when the lockfile changes — so switching branches may reinstall.
- **Versioning is via Changesets.** `pnpm changeset` to add one; `pnpm version-packages` runs `changeset version` + `scripts/sync-app-version.mjs`. The app version lives only in `apps/desktop/package.json` and is inlined everywhere as `__APP_VERSION__`.
- **CI (`.github/workflows/ci.yml`) runs only `pnpm typecheck` + `pnpm test`** on PRs (frozen-lockfile install). The Playwright `_electron` e2e suite is **not** in CI — run it locally. Keep both green before opening a PR.
- Coverage is report-only (a gap-finding lens), never a gate.
