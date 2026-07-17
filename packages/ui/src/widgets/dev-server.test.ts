import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { devServerWidget, parseDevServer } from "./dev-server.js"

const ctx = (output: string | undefined, status: "running" | "success" | "error" = "running") => ({
  command: parseCommand("pnpm dev"),
  output,
  status
})

/** `devServerWidget` isn't in the registry yet, so match on the spec itself. */
const matches = (command: string) => devServerWidget.match(parseCommand(command))

const VITE = `
  VITE v5.3.1  ready in 412 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.24:5173/
  ➜  press h + enter to show help
`

const NEXT = `
  ▲ Next.js 14.2.3
  - Local:        http://localhost:3000
  - Network:      http://192.168.1.24:3000
 ✓ Ready in 2.1s
`

const HMR = `${VITE}
10:42:18 [vite] page reload src/App.tsx
10:42:31 [vite] hmr update /src/routes/billing.tsx
`

describe("classify", () => {
  it.each(["pnpm dev", "vite", "next dev", "npm run dev", "pnpm dev:web", "pnpm serve", "yarn start", "astro dev"])(
    "routes %j to the dev server",
    (cmd) => {
      expect(matches(cmd)).toBe(true)
    }
  )

  it.each(["ls -la", "pnpm build", "vitest run", "git status", "gh pr checks"])(
    "leaves %j to another widget",
    (cmd) => {
      expect(matches(cmd)).toBe(false)
    }
  )
})

describe("parseDevServer", () => {
  it("reads vite's banner and the addresses it is listening on", () => {
    const p = parseDevServer(ctx(VITE))!
    expect(p).not.toBeNull()
    expect(p.tool).toBe("VITE")
    expect(p.version).toBe("5.3.1")
    expect(p.readyIn).toBe("412 ms")
    expect(p.urls).toEqual([
      { label: "Local", url: "http://localhost:5173/" },
      { label: "Network", url: "http://192.168.1.24:5173/" }
    ])
  })

  it("reads next's banner, which prints the same facts in a different shape", () => {
    const p = parseDevServer(ctx(NEXT))!
    expect(p.tool).toBe("Next.js")
    expect(p.version).toBe("14.2.3")
    expect(p.readyIn).toBe("2.1s")
    expect(p.urls).toHaveLength(2)
    expect(p.urls[0]).toEqual({ label: "Local", url: "http://localhost:3000" })
  })

  it("takes the port from the local address", () => {
    expect(parseDevServer(ctx(VITE))!.port).toBe("5173")
    expect(parseDevServer(ctx(NEXT))!.port).toBe("3000")
  })

  it("ignores the help line, which has no address on it", () => {
    expect(parseDevServer(ctx(VITE))!.urls.map((u) => u.label)).not.toContain("press h + enter to show help")
  })

  it("collects the hmr tail that arrives after startup", () => {
    const p = parseDevServer(ctx(HMR))!
    expect(p.logs).toEqual([
      { time: "10:42:18", event: "page reload", file: "src/App.tsx" },
      { time: "10:42:31", event: "hmr update", file: "/src/routes/billing.tsx" }
    ])
  })

  it("keeps only the last few log lines, so an all-day server stays a status card", () => {
    const many = Array.from({ length: 12 }, (_, i) => `10:42:${String(i).padStart(2, "0")} [vite] hmr update /src/${i}.tsx`)
    const p = parseDevServer(ctx(`${VITE}\n${many.join("\n")}`))!
    expect(p.logs).toHaveLength(5)
    expect(p.logs[4]!.file).toBe("/src/11.tsx")
  })

  it("declines when nothing has been printed yet, rather than claiming a server is up", () => {
    expect(parseDevServer(ctx(undefined))).toBeNull()
  })

  it("declines output it does not recognise, so the plain card still shows it", () => {
    expect(parseDevServer(ctx("bash: vite: command not found", "error"))).toBeNull()
  })

  it("renders from a banner alone, before any address has been printed", () => {
    const p = parseDevServer(ctx("  VITE v5.3.1  ready in 412 ms\n"))!
    expect(p).not.toBeNull()
    expect(p.urls).toHaveLength(0)
    expect(p.port).toBeNull()
  })

  it("renders from addresses alone, when the banner scrolled out of the capped middle", () => {
    const p = parseDevServer(ctx("  ➜  Local:   http://localhost:5173/\n"))!
    expect(p).not.toBeNull()
    expect(p.tool).toBeNull()
    expect(p.readyIn).toBeNull()
    expect(p.port).toBe("5173")
  })
})
