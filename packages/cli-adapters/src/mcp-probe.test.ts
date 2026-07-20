import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Duration, Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { McpLaunch, ParsedMcpServer } from "./mcp-config.js"
import { PROBE_TIMEOUT, probeAll, probeServer } from "./mcp-probe.js"

const FAKE_SERVER = fileURLToPath(new URL("./mcp-fixtures/fake-mcp-server.mjs", import.meta.url))

const NOW = "2026-07-18T00:00:00.000Z"
const now = () => NOW

/** Build a parsed entry whose launch half runs the fake server in a given mode. */
const stdio = (
  name: string,
  args: ReadonlyArray<string>,
  opts: { readonly enabled?: boolean; readonly env?: Record<string, string> } = {}
): ParsedMcpServer => ({
  server: {
    name,
    cli: "claude",
    transport: "stdio",
    scope: "user",
    target: `node ${name}`,
    envKeys: Object.keys(opts.env ?? {}),
    headerKeys: [],
    enabled: opts.enabled ?? true
  },
  launch: {
    transport: "stdio",
    command: process.execPath,
    args: [FAKE_SERVER, ...args],
    env: opts.env ?? {},
    headers: {}
  }
})

const remote = (name: string, url: string): ParsedMcpServer => ({
  server: {
    name,
    cli: "claude",
    transport: "http",
    scope: "user",
    target: url,
    envKeys: [],
    headerKeys: [],
    enabled: true
  },
  launch: { transport: "http", args: [], env: {}, url, headers: {} }
})

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

/**
 * Short timeout for the hang cases, so they don't cost the real 15s.
 *
 * Not as short as it looks like it could be. The same deadline governs the
 * HEALTHY server in the mixed batch, and a healthy probe still has to spawn a
 * node process and complete a handshake — which at 750ms the suite could miss
 * under parallel load, reporting a good server as failed. Sized to clear a slow
 * spawn while still costing a fraction of the real timeout.
 */
const SHORT = Duration.seconds(5)

/** Count live children of this process, to prove the probe doesn't orphan any. */
const childCount = (): number => {
  try {
    const out = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
    return out.trim().split("\n").filter(Boolean).length
  } catch {
    return 0 // pgrep exits non-zero when there are no matches
  }
}

describe("probeServer — reachable states", () => {
  it("reports connected with the server's tool count", async () => {
    const status = await run(probeServer(stdio("good", ["ok", "3"]), null, now))
    expect(status).toStrictEqual({
      name: "good",
      scope: "user",
      state: "connected",
      toolCount: 3,
      error: null,
      checkedAt: NOW
    })
  })

  it("reports disabled without probing a server the harness won't load", async () => {
    // Points at `crash`: if this were probed it would fail, so `disabled` proves we skipped it.
    const status = await run(probeServer(stdio("off", ["crash"], { enabled: false }), null, now))
    expect(status.state).toBe("disabled")
    expect(status.error).toBeNull()
    expect(status.toolCount).toBeNull()
  })

  it("reports failed when the server exits non-zero", async () => {
    const status = await run(probeServer(stdio("crashy", ["crash"]), null, now))
    expect(status.state).toBe("failed")
    expect(status.toolCount).toBeNull()
    expect(status.error).toBeTruthy()
  })

  it("reports failed when the server refuses the initialize handshake", async () => {
    const status = await run(probeServer(stdio("rude", ["protocol"]), null, now))
    expect(status.state).toBe("failed")
    expect(status.error).toContain("initialize refused")
  })

  it("reports failed when the command does not exist", async () => {
    const missing: ParsedMcpServer = {
      ...stdio("missing", []),
      launch: { transport: "stdio", command: "/nonexistent/mcp-server", args: [], env: {}, headers: {} }
    }
    const status = await run(probeServer(missing, null, now))
    expect(status.state).toBe("failed")
  })

  it("reports failed for an unreachable remote server", async () => {
    // Port 1 on loopback refuses immediately — no network access needed.
    const status = await run(probeServer(remote("dead", "http://127.0.0.1:1/mcp"), null, now))
    expect(status.state).toBe("failed")
  })

  it("reports failed rather than throwing when a stdio entry has no command", async () => {
    const broken: ParsedMcpServer = {
      ...stdio("broken", []),
      launch: { transport: "stdio", args: [], env: {}, headers: {} } as McpLaunch
    }
    const status = await run(probeServer(broken, null, now))
    expect(status.state).toBe("failed")
  })
})

describe("probeServer — timeout", () => {
  /**
   * The important failure mode: a server that accepts input and never replies must
   * not wedge the UI, and must not leave a child process behind when torn down.
   */
  it("times out a hung server and leaves no orphaned process", async () => {
    const before = childCount()
    const started = Date.now()
    // A short injected timeout — the production value is deliberately long (cold
    // `npx`), which would make this a 15s test for no extra coverage.
    const status = await run(probeServer(stdio("hung", ["hang"]), null, now, SHORT))
    const elapsed = Date.now() - started

    expect(status.state).toBe("failed")
    expect(status.error).toContain("timed out")
    expect(elapsed).toBeLessThan(Duration.toMillis(SHORT) + 5_000)

    // Give the transport a moment to reap, then confirm we're back where we started.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(childCount()).toBeLessThanOrEqual(before)
  }, 20_000)

  /**
   * The production default is long on purpose: a cold `npx -y <pkg>` regularly runs
   * past 10s, and reporting (and caching) "failed" for a healthy server is worse
   * than making the operator wait.
   */
  it("defaults to a timeout generous enough for a cold npx fetch", () => {
    expect(Duration.toMillis(PROBE_TIMEOUT)).toBeGreaterThanOrEqual(10_000)
  })
})

/**
 * The trust boundary. A project-scope entry from a harness that gates project
 * config behind its own prompt could have been committed by any repo you cloned,
 * and the harness hasn't asked yet — so we list it and refuse to run it.
 *
 * Every case here points the launch half at `crash`: if the entry were probed the
 * status would be `failed`, so `unknown` is proof no process was spawned.
 */
describe("probeServer — un-gated project servers are never spawned", () => {
  const projectEntry = (cli: "claude" | "codex" | "cursor" | "opencode"): ParsedMcpServer => {
    const base = stdio("proj", ["crash"])
    return { ...base, server: { ...base.server, cli, scope: "project" } }
  }

  it.each([["cursor" as const], ["opencode" as const]])(
    "reports %s's project server as unknown without running it",
    async (cli) => {
      const status = await run(probeServer(projectEntry(cli), null, now))
      expect(status.state).toBe("unknown")
      expect(status.toolCount).toBeNull()
      expect(status.error).toBeNull()
    }
  )

  /** Claude's project servers ARE gated in config we read, so an approved one is fair game. */
  it("still probes claude's project servers, whose approval we can see", async () => {
    const status = await run(probeServer(projectEntry("claude"), null, now))
    expect(status.state).toBe("failed")
  })

  it("still probes user-scope servers for an un-gated harness", async () => {
    const base = stdio("userSrv", ["crash"])
    const userScope = { ...base, server: { ...base.server, cli: "cursor" as const, scope: "user" as const } }
    const status = await run(probeServer(userScope, null, now))
    expect(status.state).toBe("failed")
  })

  it("still probes local-scope servers, which are this machine's own config", async () => {
    const base = stdio("localSrv", ["crash"])
    const localScope = { ...base, server: { ...base.server, cli: "cursor" as const, scope: "local" as const } }
    const status = await run(probeServer(localScope, null, now))
    expect(status.state).toBe("failed")
  })
})

describe("probeServer — credentials", () => {
  /**
   * The reason config is parsed into two halves. Probing from the redacted
   * `McpServer` would start this server without its env and report a false failure.
   */
  it("forwards configured env values so a credentialled server connects", async () => {
    const withEnv = stdio("needs-key", ["needs-env", "FAKE_API_KEY"], { env: { FAKE_API_KEY: "sk-test-value" } })
    const status = await run(probeServer(withEnv, null, now))
    expect(status.state).toBe("connected")
  })

  it("fails that same server when the env value is absent", async () => {
    const withoutEnv = stdio("needs-key", ["needs-env", "FAKE_API_KEY"])
    const status = await run(probeServer(withoutEnv, null, now))
    expect(status.state).toBe("failed")
    expect(status.error).toContain("missing FAKE_API_KEY")
  })

  /** Replacing rather than merging env would strip PATH and break nearly every server. */
  it("preserves the ambient environment alongside configured env", async () => {
    const status = await run(probeServer(stdio("inherits", ["needs-env", "PATH"]), null, now))
    expect(status.state).toBe("connected")
  })
})

describe("probeAll", () => {
  it("probes every server and preserves input order", async () => {
    const entries = [stdio("a", ["ok", "1"]), stdio("b", ["crash"]), stdio("c", ["ok", "5"])]
    const statuses = await run(probeAll(entries, null, now))
    expect(statuses.map((s) => s.name)).toStrictEqual(["a", "b", "c"])
    expect(statuses.map((s) => s.state)).toStrictEqual(["connected", "failed", "connected"])
    expect(statuses[2]?.toolCount).toBe(5)
  })

  it("returns [] for no servers without spawning anything", async () => {
    expect(await run(probeAll([], null, now))).toStrictEqual([])
  })

  /** One bad server must not sink the batch. */
  it("keeps good results when a sibling hangs", async () => {
    const statuses = await run(probeAll([stdio("good", ["ok", "2"]), stdio("hung", ["hang"])], null, now, SHORT))
    expect(statuses.find((s) => s.name === "good")?.state).toBe("connected")
    expect(statuses.find((s) => s.name === "hung")?.state).toBe("failed")
  }, 20_000)
})
