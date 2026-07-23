import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "themes",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
