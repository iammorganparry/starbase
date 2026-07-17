import { describe, expect, it } from "vitest"
import { buildWidget, parseBuild } from "./build.js"
import { parseCommand } from "./command.js"

const ctx = (output: string | undefined, status: "running" | "success" | "error" = "success") => ({
  command: parseCommand("pnpm build"),
  output,
  status
})

const VITE = `
vite v5.3.1 building for production...
transforming...
✓ 1284 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   1.24 kB │ gzip:   0.61 kB
dist/assets/index-a1b2.css       18.40 kB │ gzip:   4.13 kB
dist/assets/index-c3d4.js       246.80 kB │ gzip:  78.20 kB
dist/assets/vendor-e5f6.js      512.10 kB │ gzip: 168.00 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
✓ built in 4.12s
`

/** The same table pasted through something that flattened the box-drawing char. */
const ASCII_PIPES = `
dist/index.html                   1.24 kB | gzip:   0.61 kB
dist/assets/index-c3d4.js       246.80 kB | gzip:  78.20 kB
✓ built in 1.02s
`

describe("classify", () => {
  it.each(["pnpm build", "vite build", "turbo build", "tsup", "webpack", "next build", "rollup -c", "esbuild"])(
    "routes %j to the build widget",
    (cmd) => {
      expect(buildWidget.match(parseCommand(cmd))).toBe(true)
    }
  )

  it.each(["pnpm test", "git status", "tsc --noEmit", "ls -la"])("leaves %j to another widget", (cmd) => {
    expect(buildWidget.match(parseCommand(cmd))).toBe(false)
  })
})

describe("parseBuild", () => {
  it("reads vite's banner, module count and duration", () => {
    const p = parseBuild(ctx(VITE))!
    expect(p).not.toBeNull()
    expect(p.tool).toBe("vite")
    expect(p.toolVersion).toBe("v5.3.1")
    expect(p.modules).toBe(1284)
    expect(p.duration).toBe("4.12s")
  })

  it("reads every asset with its size and gzip size", () => {
    const p = parseBuild(ctx(VITE))!
    expect(p.assets).toHaveLength(4)
    expect(p.assets[0]).toEqual({ path: "dist/index.html", size: "1.24 kB", gzip: "0.61 kB" })
    expect(p.assets[3]).toEqual({ path: "dist/assets/vendor-e5f6.js", size: "512.10 kB", gzip: "168.00 kB" })
  })

  it("reads the asset table whether the separator survived as │ or as |", () => {
    const p = parseBuild(ctx(ASCII_PIPES))!
    expect(p.assets).toHaveLength(2)
    expect(p.assets[1]).toEqual({ path: "dist/assets/index-c3d4.js", size: "246.80 kB", gzip: "78.20 kB" })
  })

  it("keeps assets the bundler printed no gzip size for", () => {
    const p = parseBuild(ctx("dist/index.js  12.34 KiB\n✓ built in 0.40s"))!
    expect(p.assets[0]).toEqual({ path: "dist/index.js", size: "12.34 KiB", gzip: null })
  })

  it("collects the bundler's warnings", () => {
    const p = parseBuild(ctx(VITE))!
    expect(p.warnings).toHaveLength(1)
    expect(p.warnings[0]).toContain("larger than 500 kB after minification")
  })

  it("has no banner for a bundler that printed none, rather than inventing one", () => {
    const p = parseBuild(ctx(ASCII_PIPES))!
    expect(p.tool).toBeNull()
    expect(p.toolVersion).toBeNull()
    expect(p.modules).toBeNull()
  })

  it("declines when nothing has been printed yet, rather than claiming an empty bundle", () => {
    expect(parseBuild(ctx(undefined, "running"))).toBeNull()
  })

  it("declines output it does not recognise, so the plain card still shows it", () => {
    expect(parseBuild(ctx("ERR_PNPM_NO_SCRIPT  Missing script: build", "error"))).toBeNull()
  })

  it("still renders a build that produced a duration but no asset table", () => {
    const p = parseBuild(ctx("Tasks:    7 successful, 7 total\n built in 812ms"))!
    expect(p).not.toBeNull()
    expect(p.assets).toHaveLength(0)
    expect(p.duration).toBe("812ms")
  })
})

describe("warning text", () => {
  it("drops a trailing 'Consider:' that points at bullets we don't show", () => {
    const out = `dist/a.js  512.10 kB │ gzip: 168.00 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
✓ built in 4.12s`
    const p = parseBuild({ command: parseCommand("pnpm build"), output: out, status: "success" })!
    expect(p.warnings[0]).toBe("Some chunks are larger than 500 kB after minification")
  })
})
