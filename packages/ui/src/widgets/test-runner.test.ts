import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { classifyCommand } from "./registry.js"
import { parseTestRun } from "./test-runner.js"

const ctx = (output: string | undefined, status: "running" | "success" | "error" = "success") => ({
  command: parseCommand("vitest run"),
  output,
  status, meta: null
})

const VITEST = `
 ✓ src/auth/session.test.ts (22 tests) 420ms
 ✓ src/billing/refund.test.ts (18 tests) 1.10s
 ✗ src/db/migrate.test.ts (2 tests | 2 failed) 810ms

 FAIL  src/db/migrate.test.ts > migrate > applies pending migrations in order
AssertionError: expected 4 to equal 3
 ❯ src/db/migrate.test.ts:41:23

 Test Files  1 failed | 2 passed (3)
      Tests  2 failed | 128 passed | 4 skipped (134)
   Duration  3.20s
`

const JEST = `
Tests:       2 failed, 128 passed, 4 skipped, 134 total
Test Suites: 1 failed, 4 passed, 5 total
Time:        3.2 s
`

describe("classify", () => {
  it.each(["vitest run", "pnpm test", "npx jest", "pnpm --filter @starbase/ui test", "go test ./..."])(
    "routes %j to the test runner",
    (cmd) => {
      expect(classifyCommand(cmd)).toBe("test-runner")
    }
  )

  it.each(["ls -la", "pnpm build", "git status"])("leaves %j to another widget", (cmd) => {
    expect(classifyCommand(cmd)).not.toBe("test-runner")
  })
})

describe("parseTestRun", () => {
  it("reads vitest's scoreboard", () => {
    const p = parseTestRun(ctx(VITEST))!
    expect(p).not.toBeNull()
    expect(p.passed).toBe(128)
    expect(p.failed).toBe(2)
    expect(p.skipped).toBe(4)
    expect(p.total).toBe(134)
    expect(p.duration).toBe("3.20s")
  })

  it("reads jest's scoreboard", () => {
    const p = parseTestRun({ ...ctx(JEST), command: parseCommand("jest") })!
    expect(p.passed).toBe(128)
    expect(p.failed).toBe(2)
    expect(p.skipped).toBe(4)
    expect(p.total).toBe(134)
  })

  it("lists each suite file with its outcome", () => {
    const p = parseTestRun(ctx(VITEST))!
    expect(p.files).toHaveLength(3)
    expect(p.files[0]).toMatchObject({ path: "src/auth/session.test.ts", status: "pass", duration: "420ms" })
    expect(p.files[2]).toMatchObject({ path: "src/db/migrate.test.ts", status: "fail", count: "2" })
  })

  it("pulls out the failing assertion and where it happened", () => {
    const p = parseTestRun(ctx(VITEST))!
    expect(p.failures).toHaveLength(1)
    expect(p.failures[0]!.title).toContain("applies pending migrations in order")
    expect(p.failures[0]!.message).toBe("AssertionError: expected 4 to equal 3")
    expect(p.failures[0]!.at).toBe("src/db/migrate.test.ts:41:23")
  })

  it("declines when nothing has been printed yet, rather than claiming zero tests", () => {
    expect(parseTestRun(ctx(undefined, "running"))).toBeNull()
  })

  it("declines output it does not recognise, so the plain card still shows it", () => {
    expect(parseTestRun(ctx("bash: vitest: command not found", "error"))).toBeNull()
  })

  it("builds a scoreboard from streamed file lines before any summary exists", () => {
    const partial = " ✓ src/auth/session.test.ts (22 tests) 420ms\n ❯ src/api/webhook.test.ts\n"
    const p = parseTestRun(ctx(partial, "running"))!
    expect(p).not.toBeNull()
    expect(p.files).toHaveLength(2)
    expect(p.files[1]!.status).toBe("running")
  })

  it("notices watch mode from the command", () => {
    expect(parseTestRun({ ...ctx(VITEST), command: parseCommand("vitest --watch") })!.watch).toBe(true)
    expect(parseTestRun(ctx(VITEST))!.watch).toBe(false)
  })
})
