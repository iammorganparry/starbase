import { defineConfig } from "vitest/config"

/**
 * Component tests for the UI library. jsdom (not node) because the suite here
 * renders real React trees — `Markdown` in particular, whose Streamdown plugin
 * pipeline can only be checked by looking at the DOM it produces.
 *
 * Scoped deliberately narrow: this is not the full "renderer component coverage"
 * pass, it's a guard on the markdown pipeline, whose defaults are easy to break
 * invisibly (see the docblock in `src/components/markdown.tsx`).
 */
export default defineConfig({
  test: {
    name: "ui",
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
})
