import { defineConfig } from "vitest/config"

/**
 * DB-backed integration tests (real Postgres). Run locally with `docker compose
 * up -d db` + `db:migrate`, never in CI. Serial + no isolation so the single
 * module-scoped Postgres client is shared and closed once.
 */
export default defineConfig({
  test: {
    name: "server-integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000
  }
})
