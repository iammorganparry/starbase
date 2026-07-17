import { describe, expect, it } from "vitest"
import { exitLabel, explanatoryMeta, parseCommand, scrapeDuration } from "./command.js"

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
  it("treats a clean run as exit 0 — a fact, since a non-zero exit is an error", () => {
    expect(exitLabel("success")).toBe("exit 0")
  })
  it("says 'failed', not a made-up 'exit 1', when the real code is unknown", () => {
    // `command not found` is 127, a signal is 130, tsc is 2 — inventing 1 is
    // wrong most of the time, and a wrong code the operator trusts is worse
    // than no code.
    expect(exitLabel("error")).toBe("failed")
  })
  it("prefers the adapter's real exit code when it gave one (codex sends it in meta)", () => {
    expect(exitLabel("error", "exit 127")).toBe("exit 127")
    expect(exitLabel("success", "exit 0")).toBe("exit 0")
    // A non-code meta (opencode's error message) is not an exit label.
    expect(exitLabel("error", "permission denied")).toBe("failed")
  })
})

describe("explanatoryMeta", () => {
  it("passes through a non-code explanation", () => {
    expect(explanatoryMeta("permission denied")).toBe("permission denied")
  })
  it("suppresses a bare exit code, which is rendered as the exit label instead", () => {
    expect(explanatoryMeta("exit 127")).toBeNull()
    expect(explanatoryMeta(null)).toBeNull()
  })
})

describe("|| and && attribution", () => {
  it("keeps the left side of `||`, since the right only ran on failure", () => {
    // `vitest run || true` prints the vitest log and exits 0 via `true`; the
    // output is vitest's, not true's.
    expect(parseCommand("vitest run || true").program).toBe("vitest")
    expect(parseCommand("pnpm test || echo failed").sub).toBe("test")
  })
  it("takes the right side of `&&`, which only ran because the left succeeded", () => {
    expect(parseCommand("pnpm i && pnpm build").sub).toBe("build")
  })
  it("still skips a leading cd", () => {
    expect(parseCommand("cd apps/web && vitest run").program).toBe("vitest")
  })
})

describe("runner flag values are not mistaken for the script", () => {
  it("skips an unscoped --filter value", () => {
    expect(parseCommand("pnpm --filter web test").sub).toBe("test")
    expect(parseCommand("pnpm --filter web build").sub).toBe("build")
  })
  it("handles --filter=web (attached value) too", () => {
    expect(parseCommand("pnpm --filter=web test").sub).toBe("test")
  })
  it("skips -C dir and --prefix", () => {
    expect(parseCommand("pnpm -C packages/ui test").sub).toBe("test")
    expect(parseCommand("pnpm --prefix apps/web build").sub).toBe("build")
  })
})
