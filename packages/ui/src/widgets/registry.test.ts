import { describe, expect, it } from "vitest"
import { classifyCommand, renderCommandWidget } from "./registry.js"

/**
 * The registry's contract: every command reaches exactly one widget, the most
 * specific one wins, and nothing ever falls off the end.
 */

describe("routing", () => {
  it.each([
    ["vitest run", "test-runner"],
    ["pnpm test", "test-runner"],
    ["pnpm --filter @starbase/ui test", "test-runner"],
    ["pnpm build", "build"],
    ["turbo build", "build"],
    ["pnpm dev", "dev-server"],
    ["vite", "dev-server"],
    ["tsc --noEmit", "diagnostics"],
    ["pnpm typecheck", "diagnostics"],
    ["pnpm lint", "diagnostics"],
    ["pnpm install", "package-install"],
    ["pnpm add zod", "package-install"],
    ["gh pr checks 482 --watch", "ci-checks"],
    ["git commit -m 'fix'", "git-op"],
    ["psql $DATABASE_URL -c 'select 1;'", "db-query"],
    ["curl -s https://example.com", "http-request"],
    ["./scripts/seed.sh", "generic"],
    ["ls -la", "generic"]
  ])("routes %j to %s", (cmd, id) => {
    expect(classifyCommand(cmd)).toBe(id)
  })

  /*
   * The precedence hazard. `vite build` matches dev-server on its program AND
   * build on its sub-command; whichever spec is listed first wins. If someone
   * reorders SPECS, a production build starts rendering as a dev server — a
   * silent, plausible-looking wrong answer. Pin it.
   */
  it.each(["vite build", "next build"])("reads %j as a build, not a dev server", (cmd) => {
    expect(classifyCommand(cmd)).toBe("build")
  })

  it("does not mistake vitest for vite", () => {
    expect(classifyCommand("vitest run")).toBe("test-runner")
  })
})

/**
 * The way agents actually spell these commands.
 *
 * The happy path above proves the wiring; this proves the wiring survives
 * contact. Every entry is a real spelling — script vs binary, `run` vs bare,
 * workspace filters, env prefixes, `cd &&` prefixes, exec wrappers.
 */
describe("real-world spellings", () => {
  it.each([
    // test-runner
    ["vitest run --reporter=verbose", "test-runner"],
    ["pnpm vitest run src/foo.test.ts", "test-runner"],
    ["pnpm run test", "test-runner"],
    ["npm run test", "test-runner"],
    ["yarn test", "test-runner"],
    ["bun test", "test-runner"],
    ["pnpm test:unit", "test-runner"],
    ["pnpm --filter @starbase/server test:integration", "test-runner"],
    ["npx jest --ci", "test-runner"],
    ["npx playwright test", "test-runner"],
    ["go test ./...", "test-runner"],
    ["cargo test", "test-runner"],
    ["pytest -q", "test-runner"],
    ["cd apps/web && pnpm test", "test-runner"],
    ["NODE_ENV=test pnpm vitest run", "test-runner"],
    ["pnpm exec vitest run", "test-runner"],
    // build
    ["pnpm run build", "build"],
    ["turbo run build", "build"],
    ["pnpm --filter @starbase/desktop build", "build"],
    ["webpack --mode production", "build"],
    ["npx tsup", "build"],
    // dev-server
    ["pnpm run dev", "dev-server"],
    ["turbo run dev", "dev-server"],
    ["npm start", "dev-server"],
    ["pnpm --filter @starbase/desktop dev", "dev-server"],
    // diagnostics
    ["npx tsc --noEmit", "diagnostics"],
    ["pnpm run typecheck", "diagnostics"],
    ["pnpm run lint", "diagnostics"],
    ["npx eslint src --max-warnings 0", "diagnostics"],
    // package-install
    ["pnpm i", "package-install"],
    ["pnpm add -D vitest", "package-install"],
    ["npm ci", "package-install"],
    ["yarn add zod", "package-install"],
    ["pnpm remove jest", "package-install"],
    // ci-checks
    ["gh pr checks", "ci-checks"],
    ["gh pr checks 482 --watch", "ci-checks"],
    // git
    ["git commit -m 'wip'", "git-op"],
    ["git push origin HEAD", "git-op"],
    // db
    [`psql "$DATABASE_URL" -c "select 1;"`, "db-query"],
    // http
    ["curl -sS https://example.com", "http-request"],
    ["curl -X POST -d '{}' https://api.example.com/v1", "http-request"],
    // generic
    ["./scripts/deploy.sh --prod", "generic"],
    ["docker compose up -d db", "generic"],
    ["rm -rf node_modules", "generic"],
    ["echo hello", "generic"]
  ])("routes %j to %s", (cmd, id) => {
    expect(classifyCommand(cmd)).toBe(id)
  })
})

describe("the floor", () => {
  it("always renders something for a bash call", () => {
    // generic matches everything and never declines, so this can't return null.
    expect(renderCommandWidget({ command: "nonsense --xyz", output: "?", status: "success" })).not.toBeNull()
  })

  it("falls back to generic when a matched widget cannot read the output", () => {
    // Classified as a test run, but the output is a shell error — the test
    // widget declines and generic catches it, rather than rendering an empty
    // scoreboard claiming zero tests.
    expect(classifyCommand("pnpm test")).toBe("test-runner")
    expect(
      renderCommandWidget({ command: "pnpm test", output: "bash: vitest: command not found", status: "error" })?.id
    ).toBe("generic")
  })

  it("renders a command that has printed nothing yet", () => {
    expect(renderCommandWidget({ command: "pnpm test", output: undefined, status: "running" })?.id).toBe("generic")
  })
})

/**
 * The ambiguous bundlers, spelled every way. `vite`/`next`/`turbo` build OR
 * serve depending on what follows, and the two widgets sit next to each other
 * in SPECS — so these are the commands most likely to land on the wrong card.
 */
describe("build vs dev server", () => {
  it.each([
    ["vite build", "build"],
    ["next build", "build"],
    ["pnpm vite build", "build"],
    ["pnpm next build", "build"],
    ["pnpm exec vite build", "build"],
    ["npx vite build", "build"],
    ["turbo run build", "build"],
    ["vite", "dev-server"],
    ["pnpm vite", "dev-server"],
    ["next dev", "dev-server"],
    ["pnpm exec vite --host", "dev-server"],
    ["turbo run dev", "dev-server"]
  ])("routes %j to %s", (cmd, id) => {
    expect(classifyCommand(cmd)).toBe(id)
  })
})
