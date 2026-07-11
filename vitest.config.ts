import { defineConfig } from "vitest/config"

/**
 * Root Vitest config using the "projects" feature so each workspace package
 * owns its own test setup. `pnpm test` (vitest run) discovers every package
 * config matched below and runs all suites in one pass. Coverage is a
 * gap-finding lens (report only), never a gate.
 */
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Scoped to the backend logic this pass covers. Renderer/UI component
      // coverage belongs to the deferred jsdom + Testing Library pass.
      include: [
        "packages/core/src/**",
        "packages/contracts/src/**",
        "packages/cli-adapters/src/**",
        "apps/desktop/src/main/**"
      ],
      exclude: ["**/*.test.ts", "**/index.ts", "**/test-support.ts"]
    }
  }
})
