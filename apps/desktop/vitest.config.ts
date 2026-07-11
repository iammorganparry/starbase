import { defineConfig } from "vitest/config"

/**
 * Only the main-process (Node) logic is unit-tested here — RPC handler folding
 * behaviour. Renderer/component tests (jsdom) are a separate, later pass.
 */
export default defineConfig({
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/main/**/*.test.ts"]
  }
})
