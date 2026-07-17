import { describe, expect, it } from "vitest"
import { ciChecksWidget, parseCiChecks } from "./ci-checks.js"
import { parseCommand } from "./command.js"

const ctx = (
  output: string | undefined,
  status: "running" | "success" | "error" = "success",
  command = "gh pr checks 482 --watch"
) => ({
  command: parseCommand(command),
  output,
  status
})

/** `ciChecksWidget` isn't in the registry yet, so match on the spec itself. */
const matches = (command: string) => ciChecksWidget.match(parseCommand(command))

const TSV = [
  "build\tpass\t1m4s\thttps://github.com/o/r/actions/runs/1",
  "unit\tpass\t48s\thttps://github.com/o/r/actions/runs/2",
  "e2e-playwright\tpending\t2m12s\thttps://github.com/o/r/actions/runs/3",
  "deploy-preview\tqueued\t\thttps://github.com/o/r/actions/runs/4"
].join("\n")

const HUMAN = `All checks were successful
0 failing, 3 successful, 0 skipped, and 1 pending checks

✓  build         1m4s  https://github.com/o/r/actions/runs/1
✓  unit          48s   https://github.com/o/r/actions/runs/2
*  e2e           2m12s https://github.com/o/r/actions/runs/3
`

describe("classify", () => {
  it.each(["gh pr checks 482 --watch", "gh pr checks", "gh run watch", "gh run list", "gh run view 12"])(
    "routes %j to the ci checks widget",
    (cmd) => {
      expect(matches(cmd)).toBe(true)
    }
  )

  it.each(["gh pr create", "gh pr view 482", "git status", "pnpm test", "gh run rerun"])(
    "leaves %j to another widget",
    (cmd) => {
      expect(matches(cmd)).toBe(false)
    }
  )
})

describe("parseCiChecks", () => {
  it("reads gh's tsv, which is what it prints without a tty", () => {
    const p = parseCiChecks(ctx(TSV))!
    expect(p).not.toBeNull()
    expect(p.checks).toEqual([
      { name: "build", state: "pass", duration: "1m4s" },
      { name: "unit", state: "pass", duration: "48s" },
      { name: "e2e-playwright", state: "running", duration: "2m12s" },
      { name: "deploy-preview", state: "queued", duration: null }
    ])
  })

  it("reads the human format too, since gh switches on a tty", () => {
    const p = parseCiChecks(ctx(HUMAN))!
    expect(p.checks).toEqual([
      { name: "build", state: "pass", duration: "1m4s" },
      { name: "unit", state: "pass", duration: "48s" },
      { name: "e2e", state: "running", duration: "2m12s" }
    ])
  })

  it("maps every state word gh uses in the wild", () => {
    const out = [
      "a\tpass\t1s\thttps://x/1",
      "b\tfail\t2s\thttps://x/2",
      "c\tpending\t3s\thttps://x/3",
      "d\tqueued\t\thttps://x/4",
      "e\tskipping\t\thttps://x/5",
      "f\tcancelled\t4s\thttps://x/6"
    ].join("\n")
    expect(parseCiChecks(ctx(out))!.checks.map((c) => c.state)).toEqual([
      "pass",
      "fail",
      "running",
      "queued",
      "skipped",
      "cancelled"
    ])
  })

  it("drops rows whose state it does not know, rather than guessing at them", () => {
    const p = parseCiChecks(ctx(`build\tpass\t1s\thttps://x/1\nmystery\tfrobnicating\t2s\thttps://x/2`))!
    expect(p.checks).toHaveLength(1)
    expect(p.checks[0]!.name).toBe("build")
  })

  it("takes the pr number from the command", () => {
    expect(parseCiChecks(ctx(TSV))!.pr).toBe("482")
  })

  it("leaves the pr null when gh resolves it from the current branch", () => {
    expect(parseCiChecks(ctx(TSV, "success", "gh pr checks --watch"))!.pr).toBeNull()
  })

  it("never claims a branch, because the output never names one", () => {
    expect(parseCiChecks(ctx(TSV))!.branch).toBeNull()
  })

  it("declines when nothing has been printed yet, rather than claiming zero checks", () => {
    expect(parseCiChecks(ctx(undefined, "running"))).toBeNull()
  })

  it("declines output it does not recognise, so the plain card still shows it", () => {
    expect(parseCiChecks(ctx("no checks reported on the 'feat/oauth' branch", "error"))).toBeNull()
  })

  it("renders a partial board while checks are still arriving", () => {
    const p = parseCiChecks(ctx("build\tpass\t1m4s\thttps://x/1\nunit\tpending\t12s\thttps://x/2", "running"))!
    expect(p).not.toBeNull()
    expect(p.checks).toHaveLength(2)
    expect(p.checks[1]!.state).toBe("running")
  })
})
