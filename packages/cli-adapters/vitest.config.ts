import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "cli-adapters",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // git/worktree/filesystem tests shell out to real `git` against temp dirs.
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
