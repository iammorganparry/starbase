import { expect, test } from "./fixtures.js"
import type { LaunchOptions, SeedSession } from "./fixtures.js"

/**
 * opencode as a harness, end to end against the built app and a deterministic
 * fake `opencode` on PATH.
 *
 * The shim is the point. Discovery probes PATH, so the existing model-chip tests
 * `test.skip()` on any host without a harness installed — leaving the
 * provider-switching path untested exactly where it matters. It also lets us
 * drive states a real install can't be put into on demand: a too-old binary, or
 * a provider with no key.
 *
 * We assert on what the operator sees, never on internals.
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "starbase/refactor",
    title: "Refactor auth flow",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

/** A ready opencode: current version, Zen built in, OpenRouter live from an env key. */
const READY: NonNullable<LaunchOptions["opencode"]> = {
  version: "1.18.0",
  providers: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      source: "custom",
      env: ["OPENCODE_API_KEY"],
      models: ["big-pickle"]
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      source: "env",
      env: ["OPENROUTER_API_KEY"],
      // A three-segment id: the case a naive `split("/")` mangles.
      models: ["anthropic/claude-opus-4.5"]
    }
  ]
}

/** Open Settings (it lands on Providers) and select the opencode card. */
const openOpencodeProvider = async (window: import("@playwright/test").Page) => {
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByText("opencode", { exact: true }).first().click()
}

test("an installed opencode is offered as a harness", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    opencode: READY
  })
  await openOpencodeProvider(window)
  // Reported ready, at the version the shim announced — not "not installed".
  await expect(window.getByText(/ready · v1\.18\.0/)).toBeVisible()
})

/**
 * The version gate. The 1.0.x line can't be driven the way the adapter expects,
 * so it must NOT be offered — but an installed-yet-rejected binary has to say so,
 * or "not installed" about a binary sitting right there on PATH is a miserable
 * thing to debug. Nothing else in the suite proves the gate actually gates.
 */
test("a too-old opencode is refused, and explains itself", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    opencode: { ...READY, version: "1.0.220" }
  })
  await openOpencodeProvider(window)

  await expect(window.getByText("not installed").first()).toBeVisible()
  // The note names the version found, what's needed, and the way out.
  await expect(window.getByText(/1\.0\.220 found/)).toBeVisible()
  await expect(window.getByText(/needs 1\.18 or newer/)).toBeVisible()
  await expect(window.getByText(/opencode upgrade/)).toBeVisible()
})

test("opencode's providers show where each credential came from", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    opencode: {
      ...READY,
      providers: [
        ...READY.providers!,
        // Present but unconfigured — the case Settings exists to fix.
        { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: [] }
      ]
    }
  })
  await openOpencodeProvider(window)

  // Scope to the Providers field: the provider NAMES also appear on the model
  // cards below (labels carry the provider), so an unscoped match is ambiguous.
  const providers = window.getByText("opencode brings its own providers.").locator("..")

  // OpenRouter is live because of the user's OWN env var — and we say so rather
  // than implying Starbase configured it.
  await expect(providers.getByText("OpenRouter", { exact: true })).toBeVisible()
  await expect(providers.getByText("environment")).toBeVisible()
  await expect(providers.getByText("OpenCode Zen", { exact: true })).toBeVisible()
  await expect(providers.getByText("built-in")).toBeVisible()

  // The unconfigured one names the env var to export instead of making the user
  // go and find it.
  await expect(providers.getByText("Anthropic", { exact: true })).toBeVisible()
  await expect(providers.getByText(/export ANTHROPIC_API_KEY/)).toBeVisible()
})

/**
 * The BYOK contract, asserted where it counts: a key typed into Starbase is
 * written to OPENCODE's own credential store — so it works in a bare `opencode`
 * shell too — and never into Starbase's SecretStore.
 */
test("a key added in Starbase is written to opencode's own credential store", async ({
  launchApp
}) => {
  const { window, opencodeAuthWrites } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    opencode: {
      ...READY,
      providers: [{ id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: [] }]
    }
  })
  await openOpencodeProvider(window)

  await expect(window.getByText("Anthropic", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Add key" }).click()
  await window.getByPlaceholder("anthropic API key").fill("sk-ant-e2e-key")
  // Scoped to the key row — the provider-config footer has its own Save.
  const keyRow = window.getByPlaceholder("anthropic API key").locator("..")
  await keyRow.getByRole("button", { name: "Save" }).click()

  await expect.poll(() => opencodeAuthWrites().length).toBeGreaterThan(0)
  expect(opencodeAuthWrites()[0]).toMatchObject({
    id: "anthropic",
    body: { type: "api", key: "sk-ant-e2e-key" }
  })
})

/**
 * Provider switching from the composer's model chip. Mirrors the existing Codex
 * test, but deterministic via the shim — so it asserts rather than skips.
 */
test("the model chip lists opencode's models and switches to it", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    opencode: READY
  })
  await expect(window.getByPlaceholder("Message Claude…")).toBeVisible()

  await window.getByRole("button", { name: /opus/ }).click()
  await expect(window.getByText("opencode", { exact: true }).first()).toBeVisible()

  // Labels carry the provider because the menu groups by HARNESS — every
  // opencode model shares one section, so the model name alone is ambiguous.
  await window.getByRole("menuitem", { name: "openrouter · anthropic/claude-opus-4.5" }).click()

  // The chip follows the pick, and the composer now addresses the new harness.
  await expect(window.getByRole("button", { name: /claude-opus-4\.5/ })).toBeVisible()
  await expect(window.getByPlaceholder("Message opencode…")).toBeVisible()
})
