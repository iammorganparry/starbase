import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The sign-in wall. The whole app is gated behind BetterAuth, so these assert the
 * wall shows when signed out, the magic-link flow reaches its "sent" state, and a
 * `starbase://` deep-link callback signs the user in and drops them into the app.
 * All offline: the fixture runs a fake auth backend and a plaintext token store.
 */

const seeded: SeedSession = {
  id: "s_auth_1",
  repo: "widget",
  branch: "starbase/seed",
  title: "Seeded session",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-11T00:00:00.000Z"
}

test("signed out shows the sign-in wall", async ({ launchApp }) => {
  const { window } = await launchApp({ signedIn: false })
  await expect(window.getByRole("heading", { name: "Sign in to Starbase" })).toBeVisible()
  await expect(window.getByRole("button", { name: /continue with github/i })).toBeVisible()
  await expect(window.getByRole("button", { name: /continue with google/i })).toBeVisible()
  // The app shell must NOT be reachable behind the wall.
  await expect(window.getByText("Sessions", { exact: true })).toHaveCount(0)
})

test("requesting a magic link shows the sent confirmation", async ({ launchApp }) => {
  const { window, authServer } = await launchApp({ signedIn: false })
  await window.getByPlaceholder("you@company.com").fill("founder@example.com")
  await window.getByRole("button", { name: /send magic link/i }).click()
  await expect(window.getByText(/sign-in link sent to/i)).toBeVisible()
  await expect(window.getByText("founder@example.com")).toBeVisible()
  expect(authServer.sentEmails).toContain("founder@example.com")
})

test("a rejected magic-link request shows the error state", async ({ launchApp }) => {
  const { window } = await launchApp({ signedIn: false })
  // The fake backend rejects any address containing "fail".
  await window.getByPlaceholder("you@company.com").fill("fail@example.com")
  await window.getByRole("button", { name: /send magic link/i }).click()
  await expect(window.getByText(/couldn't send the sign-in link/i)).toBeVisible()
  // Still on the wall, and can retry.
  await expect(window.getByRole("heading", { name: "Sign in to Starbase" })).toBeVisible()
})

test("OAuth opens the provider URL and the callback signs in", async ({ launchApp }) => {
  const { window, app, authServer, completeDeepLinkSignIn } = await launchApp({
    signedIn: false,
    configured: true,
    withRepo: true,
    sessions: [seeded]
  })
  // Stub shell.openExternal in the main process so no real browser opens, and
  // record what the OAuth flow asked to open.
  await app.evaluate(({ shell }) => {
    ;(globalThis as unknown as { __opened: Array<string> }).__opened = []
    shell.openExternal = async (url: string) => {
      ;(globalThis as unknown as { __opened: Array<string> }).__opened.push(url)
    }
  })
  await window.getByRole("button", { name: /continue with github/i }).click()

  // The provider URL (from the fake backend's /sign-in/social) was opened.
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: Array<string> }).__opened))
    .toContainEqual(expect.stringContaining("/desktop/callback"))
  expect(authServer.url).toContain("127.0.0.1")

  // The browser flow returns via the deep link → signed in → app shell.
  await completeDeepLinkSignIn()
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
})

test("a deep-link callback signs in and reaches the app shell", async ({ launchApp }) => {
  const { window, completeDeepLinkSignIn } = await launchApp({
    signedIn: false,
    configured: true,
    withRepo: true,
    sessions: [seeded]
  })
  // Wall first…
  await expect(window.getByRole("heading", { name: "Sign in to Starbase" })).toBeVisible()
  // …then the OS hands back the starbase:// callback → signed in → app shell.
  await completeDeepLinkSignIn()
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await expect(window.getByText("Seeded session")).toBeVisible()
  await expect(window.getByRole("heading", { name: "Sign in to Starbase" })).toHaveCount(0)
})

test("a stored token boots straight past the wall", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: [seeded] })
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await expect(window.getByRole("heading", { name: "Sign in to Starbase" })).toHaveCount(0)
})
