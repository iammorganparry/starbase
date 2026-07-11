import { defineConfig } from "@playwright/test"

/**
 * E2E against the real, built Electron app (Playwright's `_electron`). There is
 * no web server: `global-setup` builds the app once, and each test launches the
 * built `out/main/index.js` pointed at a throwaway `STARBASE_HOME`. Serial +
 * single worker because each launch is a full Electron process.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure" }
})
