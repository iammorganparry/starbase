import { describe, expect, it } from "vitest"
import { exitLabel, parseCommand, scrapeDuration } from "./command.js"

describe("parseCommand", () => {
  it("reads a plain invocation", () => {
    const c = parseCommand("vitest run")
    expect(c.program).toBe("vitest")
    expect(c.sub).toBe("run")
  })

  it("takes the last segment, since that is what produced the output", () => {
    expect(parseCommand("cd apps/web && pnpm build").primary).toBe("pnpm build")
  })

  it("ignores a semicolon inside quotes", () => {
    const c = parseCommand(`git commit -m "fix; ship it"`)
    expect(c.program).toBe("git")
    expect(c.sub).toBe("commit")
  })

  it("drops leading env assignments", () => {
    expect(parseCommand("NODE_ENV=test pnpm vitest").program).toBe("pnpm")
    expect(parseCommand("NODE_ENV=test vitest run").program).toBe("vitest")
  })

  it("keeps the package manager for a script, so `pnpm test` is a test run", () => {
    const c = parseCommand("pnpm test")
    expect(c.program).toBe("pnpm")
    expect(c.sub).toBe("test")
  })

  it("promotes the wrapped program for exec-style runners", () => {
    expect(parseCommand("npx tsc --noEmit").program).toBe("tsc")
    expect(parseCommand("pnpm exec vitest run").program).toBe("vitest")
  })

  it("skips runner flags to find the script", () => {
    const c = parseCommand("pnpm --filter @starbase/ui test")
    expect(c.sub).toBe("test")
  })

  it("strips a bin path", () => {
    expect(parseCommand("./node_modules/.bin/vitest run").program).toBe("vitest")
  })

  it("does not split on a pipe — the pipeline's output is still the command's", () => {
    expect(parseCommand("vitest run | tee out.log").program).toBe("vitest")
  })
})

describe("scrapeDuration", () => {
  it.each([
    ["✓ built in 4.12s", "4.12s"],
    ["Done in 6.3s", "6.3s"],
    ["  VITE v5.3.1  ready in 412 ms", "412ms"],
    ["   Duration  3.20s", "3.20s"],
    ["Time:        3.2 s", "3.2s"]
  ])("reads %j", (out, want) => {
    expect(scrapeDuration(out)).toBe(want)
  })

  it("returns null when the tool said nothing — we never invent a timing", () => {
    expect(scrapeDuration("hello")).toBeNull()
    expect(scrapeDuration(undefined)).toBeNull()
  })
})

describe("exitLabel", () => {
  it("has no exit code while still running", () => {
    expect(exitLabel("running")).toBeNull()
  })
  it("derives the code from status", () => {
    expect(exitLabel("success")).toBe("exit 0")
    expect(exitLabel("error")).toBe("exit 1")
  })
})
