import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { diagnosticsWidget, parseDiagnostics } from "./diagnostics.js"

const ctx = (output: string | undefined, status: "running" | "success" | "error" = "error") => ({
  command: parseCommand("tsc --noEmit"),
  output,
  status, meta: null
})

const TSC = `
src/api/webhook.ts(41,12): error TS18048: 'payload' is possibly 'undefined'.
src/api/webhook.ts(58,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/db/migrate.ts(12,7): error TS2554: Expected 2 arguments, but got 1.

Found 3 errors in 2 files.
`

const ESLINT = `
/Users/dev/repo/src/api/webhook.ts
  41:12  error    'payload' is possibly undefined  no-unsafe-optional-chaining
  58:3   warning  Missing return type              @typescript-eslint/explicit-function-return-type

/Users/dev/repo/src/db/migrate.ts
  12:7   error    Unexpected console statement     no-console

✖ 3 problems (2 errors, 1 warning)
`

describe("classify", () => {
  it.each(["tsc --noEmit", "pnpm typecheck", "eslint .", "biome check .", "ruff check src", "pnpm lint"])(
    "routes %j to the diagnostics widget",
    (cmd) => {
      expect(diagnosticsWidget.match(parseCommand(cmd))).toBe(true)
    }
  )

  it.each(["pnpm test", "pnpm build", "git status", "vite build"])("leaves %j to another widget", (cmd) => {
    expect(diagnosticsWidget.match(parseCommand(cmd))).toBe(false)
  })
})

describe("parseDiagnostics", () => {
  it("reads tsc's diagnostics, grouped under the file that caused them", () => {
    const p = parseDiagnostics(ctx(TSC))!
    expect(p).not.toBeNull()
    expect(p.files).toHaveLength(2)
    expect(p.files[0]!.path).toBe("src/api/webhook.ts")
    expect(p.files[0]!.diagnostics).toHaveLength(2)
    expect(p.files[0]!.diagnostics[0]).toEqual({
      line: 41,
      col: 12,
      severity: "error",
      message: "'payload' is possibly 'undefined'.",
      code: "ts(18048)"
    })
    expect(p.files[1]!.path).toBe("src/db/migrate.ts")
  })

  it("reads eslint's stylish output, splitting the message from the rule", () => {
    const p = parseDiagnostics({ ...ctx(ESLINT), command: parseCommand("eslint .") })!
    expect(p.files).toHaveLength(2)
    expect(p.files[0]!.diagnostics[0]).toEqual({
      line: 41,
      col: 12,
      severity: "error",
      message: "'payload' is possibly undefined",
      code: "no-unsafe-optional-chaining"
    })
    expect(p.files[0]!.diagnostics[1]).toMatchObject({
      severity: "warning",
      message: "Missing return type",
      code: "@typescript-eslint/explicit-function-return-type"
    })
  })

  it("strips the shared root off absolute paths, so files read as they do in the repo", () => {
    const p = parseDiagnostics({ ...ctx(ESLINT), command: parseCommand("eslint .") })!
    expect(p.files.map((f) => f.path)).toEqual(["src/api/webhook.ts", "src/db/migrate.ts"])
  })

  it("trusts the tool's own totals over what survived the elided middle", () => {
    const capped = TSC.replace("Found 3 errors in 2 files.", "… 41,204 characters omitted …\n\nFound 214 errors in 37 files.")
    const p = parseDiagnostics(ctx(capped))!
    expect(p.files).toHaveLength(2)
    expect(p.errorCount).toBe(214)
  })

  it("counts errors and warnings from eslint's summary", () => {
    const p = parseDiagnostics({ ...ctx(ESLINT), command: parseCommand("eslint .") })!
    expect(p.errorCount).toBe(2)
    expect(p.warningCount).toBe(1)
  })

  it("counts what it parsed when the tool printed no summary", () => {
    const p = parseDiagnostics(ctx("src/a.ts(1,1): error TS1005: ';' expected.\n"))!
    expect(p.errorCount).toBe(1)
    expect(p.warningCount).toBe(0)
  })

  it("declines when nothing has been printed yet, rather than claiming a clean run", () => {
    expect(parseDiagnostics(ctx(undefined, "running"))).toBeNull()
  })

  it("declines output it does not recognise, so the plain card still shows it", () => {
    expect(parseDiagnostics(ctx("error TS5083: Cannot read file 'tsconfig.json'.", "error"))).toBeNull()
  })

  it("declines a clean run, which has no problems to file", () => {
    expect(parseDiagnostics(ctx("", "success"))).toBeNull()
  })
})
