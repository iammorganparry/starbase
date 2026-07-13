import { defineConfig } from "vitest/config"

/**
 * Node-environment unit tests for the desktop app: the main-process RPC handler
 * folding, plus the renderer's conversation state machine (pure XState logic with
 * `rpc-client` mocked — no `window`, so it runs under node). Renderer *component*
 * tests (jsdom + Testing Library) remain a separate, later pass.
 */
export default defineConfig({
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/main/**/*.test.ts", "src/renderer/**/*.test.ts"]
  }
})
