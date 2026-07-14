import { defineConfig } from "vitest/config"

/**
 * Node-environment unit tests for the auth server. Repository logic is tested
 * against a fake `Database` (no live Postgres), so it runs in CI.
 */
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
