import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { packageInstallWidget, parsePackageInstall } from "./package-install.js"

const ctx = (output: string | undefined, status: "running" | "success" | "error" = "success", command = "pnpm install") => ({
  command: parseCommand(command),
  output,
  status, meta: null
})

const PNPM = `
Lockfile is up to date, resolution step is skipped
Packages: +12 -3
++++++++++++---
Progress: resolved 120, reused 118, downloaded 0, added 0
Progress: resolved 412, reused 400, downloaded 12, added 12, done

dependencies:
+ @tanstack/react-query 5.51.1
+ zod 3.23.8
- jest 29.7.0

devDependencies:
+ vitest 2.0.4

Done in 6.3s
`

const NPM = `
added 12 packages, removed 3 packages, and audited 412 packages in 6s

54 packages are looking for funding
`

describe("classify", () => {
  const matches = (cmd: string) => packageInstallWidget.match(parseCommand(cmd))

  it.each(["pnpm install", "npm ci", "yarn add zod", "bun install", "pnpm i", "npm uninstall jest", "pnpm --filter @starbase/ui install"])(
    "routes %j to the package install widget",
    (cmd) => {
      expect(matches(cmd)).toBe(true)
    }
  )

  it.each(["pnpm test", "pnpm build", "git commit -m x", "vitest run", "npx tsc"])(
    "leaves %j to another widget",
    (cmd) => {
      expect(matches(cmd)).toBe(false)
    }
  )
})

describe("parsePackageInstall", () => {
  it("reads pnpm's finished tally rather than a snapshot of the middle", () => {
    const p = parsePackageInstall(ctx(PNPM))!
    expect(p.resolved).toBe(412)
    expect(p.reused).toBe(400)
    expect(p.downloaded).toBe(12)
    expect(p.duration).toBe("6.3s")
  })

  it("prefers pnpm's Packages line over counting the listed rows, since it counts the whole tree", () => {
    const p = parsePackageInstall(ctx(PNPM))!
    expect(p.added).toBe(12)
    expect(p.removed).toBe(3)
  })

  it("lists each dependency with its version and direction", () => {
    const p = parsePackageInstall(ctx(PNPM))!
    expect(p.packages).toHaveLength(4)
    expect(p.packages[0]).toEqual({ name: "@tanstack/react-query", version: "5.51.1", change: "add" })
    expect(p.packages[2]).toEqual({ name: "jest", version: "29.7.0", change: "remove" })
    expect(p.packages[3]).toEqual({ name: "vitest", version: "2.0.4", change: "add" })
  })

  it("does not mistake pnpm's progress bar for a dependency row", () => {
    expect(parsePackageInstall(ctx(PNPM))!.packages.every((p) => p.name !== "")).toBe(true)
  })

  it("reads npm's one-liner, which names no packages at all", () => {
    const p = parsePackageInstall(ctx(NPM, "success", "npm install"))!
    expect(p.added).toBe(12)
    expect(p.removed).toBe(3)
    // npm calls the resolved tree "audited".
    expect(p.resolved).toBe(412)
    expect(p.reused).toBeNull()
    expect(p.packages).toHaveLength(0)
    expect(p.duration).toBe("6s")
  })

  it("counts the rows when neither manager states a total", () => {
    const rowsOnly = "dependencies:\n+ zod 3.23.8\n+ ky 1.2.0\n- jest 29.7.0\n"
    const p = parsePackageInstall(ctx(rowsOnly))!
    expect(p.added).toBe(2)
    expect(p.removed).toBe(1)
  })

  it("keeps a package whose version pnpm annotated", () => {
    const p = parsePackageInstall(ctx("dependencies:\n+ typescript 5.4.5 (5.5.2 is available)\n"))!
    expect(p.packages[0]).toEqual({ name: "typescript", version: "5.4.5", change: "add" })
  })

  it("distinguishes an untouched lockfile from an updated one, and from silence", () => {
    expect(parsePackageInstall(ctx(PNPM))!.lockfileUpdated).toBe(false)
    expect(parsePackageInstall(ctx("Progress: resolved 4, reused 4\nUpdating lockfile...\n"))!.lockfileUpdated).toBe(true)
    expect(parsePackageInstall(ctx(NPM, "success", "npm install"))!.lockfileUpdated).toBeNull()
  })

  it("declines when nothing has been printed yet, rather than claiming an empty install", () => {
    expect(parsePackageInstall(ctx(undefined, "running"))).toBeNull()
  })

  it("declines output it does not recognise, so the plain card still shows it", () => {
    expect(parsePackageInstall(ctx("ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/x: Forbidden", "error"))).toBeNull()
  })
})
