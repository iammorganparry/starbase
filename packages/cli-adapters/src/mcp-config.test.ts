import { describe, expect, it } from "vitest"
import type { ParsedMcpServer } from "./mcp-config.js"
import {
  claudeLocalServers,
  claudeProjectGate,
  claudeProjectServers,
  claudeSettingsServers,
  claudeUserServers,
  codexServers,
  cursorServers,
  mergeByScope,
  opencodeServers
} from "./mcp-config.js"

/**
 * A value that must NEVER appear in the redacted half of a parse. Every fixture
 * below plants it in an env/header map; the redaction suite greps for it.
 */
const SECRET = "sk-live-DO-NOT-LEAK-0000"

/** The redacted, renderer-facing half — what most assertions here care about. */
const pub = (parsed: ReadonlyArray<ParsedMcpServer>) => parsed.map((p) => p.server)

// ── Claude ───────────────────────────────────────────────────────────────────

describe("claudeUserServers", () => {
  it("reads top-level mcpServers as user scope", () => {
    const servers = pub(
      claudeUserServers(JSON.stringify({ mcpServers: { obsidian: { command: "npx", args: ["-y", "obsidian-mcp"] } } }))
    )
    expect(servers).toStrictEqual([
      {
        name: "obsidian",
        cli: "claude",
        transport: "stdio",
        scope: "user",
        target: "npx -y obsidian-mcp",
        envKeys: [],
        headerKeys: [],
        enabled: true
      }
    ])
  })

  it("reads a remote server, defaulting an unlabelled url to http", () => {
    const servers = pub(claudeUserServers(JSON.stringify({ mcpServers: { posthog: { url: "https://mcp.posthog.com/mcp" } } })))
    expect(servers[0]?.transport).toBe("http")
    expect(servers[0]?.target).toBe("https://mcp.posthog.com/mcp")
  })

  /**
   * MCP URLs routinely carry credentials in the query string, and `target` is sent
   * to the renderer — so the query is dropped from the display half while the launch
   * half keeps the full URL.
   */
  it("drops the query string from a remote target but keeps it for launching", () => {
    const raw = JSON.stringify({
      mcpServers: { supabase: { url: "https://mcp.supabase.com/mcp?project_ref=abc&api_key=" + SECRET } }
    })
    const [entry] = claudeUserServers(raw)
    expect(entry?.server.target).toBe("https://mcp.supabase.com/mcp")
    expect(entry?.server.target).not.toContain(SECRET)
    expect(entry?.launch.url).toContain(SECRET)
  })

  it("drops the query from an unparseable url rather than guessing", () => {
    const raw = JSON.stringify({ mcpServers: { odd: { url: "not-a-url?key=" + SECRET } } })
    expect(claudeUserServers(raw)[0]?.server.target).toBe("not-a-url")
  })

  it("honours an explicit sse type", () => {
    const servers = pub(claudeUserServers(JSON.stringify({ mcpServers: { s: { type: "sse", url: "https://x/sse" } } })))
    expect(servers[0]?.transport).toBe("sse")
  })

  it("skips an entry with neither command nor url", () => {
    expect(pub(claudeUserServers(JSON.stringify({ mcpServers: { broken: { note: "nothing here" } } })))).toStrictEqual([])
  })

  it.each([
    ["empty string", ""],
    ["malformed json", "{ not json"],
    ["json array", "[]"],
    ["object with no mcpServers", "{}"],
    ["mcpServers as an array", JSON.stringify({ mcpServers: [] })],
    ["mcpServers null", JSON.stringify({ mcpServers: null })]
  ])("yields [] for %s", (_label, raw) => {
    expect(claudeUserServers(raw)).toStrictEqual([])
  })
})

describe("claudeSettingsServers", () => {
  it("reads mcpServers out of ~/.claude/settings.json as user scope", () => {
    const servers = pub(claudeSettingsServers(JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } })))
    expect(servers).toHaveLength(1)
    expect(servers[0]?.scope).toBe("user")
  })

  it("yields [] when settings.json has no mcpServers", () => {
    expect(claudeSettingsServers(JSON.stringify({ theme: "dark" }))).toStrictEqual([])
  })
})

describe("claudeLocalServers", () => {
  const CONFIG = JSON.stringify({
    projects: {
      "/repos/app": { mcpServers: { sentry: { command: "sentry-mcp" } } },
      "/repos/other": { mcpServers: { nope: { command: "nope" } } }
    }
  })

  it("reads only the matching project's servers, as local scope", () => {
    const servers = pub(claudeLocalServers(CONFIG, "/repos/app"))
    expect(servers.map((s) => s.name)).toStrictEqual(["sentry"])
    expect(servers[0]?.scope).toBe("local")
  })

  /**
   * The worktree gotcha, pinned. Sessions run in a worktree, so the projects key is
   * the worktree path — a server registered against the original checkout does not
   * apply, and we must not pretend it does.
   */
  it("yields [] for a path with no entry, e.g. a worktree of a registered repo", () => {
    expect(claudeLocalServers(CONFIG, "/repos/app-worktree-27")).toStrictEqual([])
  })

  it.each([
    ["no projects key", "{}"],
    ["projects not an object", JSON.stringify({ projects: [] })],
    ["malformed json", "{{{"]
  ])("yields [] for %s", (_label, raw) => {
    expect(claudeLocalServers(raw, "/repos/app")).toStrictEqual([])
  })
})

describe("claudeProjectGate + claudeProjectServers", () => {
  const MCP_JSON = JSON.stringify({
    mcpServers: { approved: { command: "a" }, pending: { command: "b" }, denied: { command: "c" } }
  })

  const enabledByName = (parsed: ReadonlyArray<ParsedMcpServer>) =>
    Object.fromEntries(pub(parsed).map((s) => [s.name, s.enabled]))

  it("marks an allow-listed server enabled and an unlisted one disabled", () => {
    const gate = claudeProjectGate(JSON.stringify({ enabledMcpjsonServers: ["approved"] }))
    expect(enabledByName(claudeProjectServers(MCP_JSON, gate))).toStrictEqual({
      approved: true,
      pending: false,
      denied: false
    })
  })

  it("deny-list beats allow-list for the same name", () => {
    const gate = claudeProjectGate(
      JSON.stringify({ enabledMcpjsonServers: ["denied"], disabledMcpjsonServers: ["denied"] })
    )
    expect(enabledByName(claudeProjectServers(MCP_JSON, gate)).denied).toBe(false)
  })

  it("deny-list beats enableAllProjectMcpServers", () => {
    const gate = claudeProjectGate(
      JSON.stringify({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ["denied"] })
    )
    expect(enabledByName(claudeProjectServers(MCP_JSON, gate))).toStrictEqual({
      approved: true,
      pending: true,
      denied: false
    })
  })

  /** Unapproved servers are surfaced as disabled, not hidden — the operator needs to see why nothing loaded. */
  it("still lists unapproved servers so they are visible as disabled", () => {
    const servers = pub(claudeProjectServers(MCP_JSON, claudeProjectGate("{}")))
    expect(servers).toHaveLength(3)
    expect(servers.every((s) => s.enabled === false)).toBe(true)
    expect(servers.every((s) => s.scope === "project")).toBe(true)
  })

  it("treats an absent gate as fully enabled", () => {
    expect(pub(claudeProjectServers(MCP_JSON)).every((s) => s.enabled)).toBe(true)
  })

  it("returns a permissive-by-default gate for malformed settings", () => {
    expect(claudeProjectGate("{{{")).toStrictEqual({ enableAll: false, enabled: [], disabled: [] })
  })
})

// ── Cursor ───────────────────────────────────────────────────────────────────

describe("cursorServers", () => {
  it.each([["user" as const], ["project" as const]])("reads the shared mcpServers shape at %s scope", (scope) => {
    const servers = pub(cursorServers(JSON.stringify({ mcpServers: { posthog: { url: "https://mcp.posthog.com/mcp" } } }), scope))
    expect(servers).toHaveLength(1)
    expect(servers[0]?.scope).toBe(scope)
    expect(servers[0]?.cli).toBe("cursor")
  })

  it("yields [] for an empty or malformed file", () => {
    expect(cursorServers("", "user")).toStrictEqual([])
    expect(cursorServers("nope", "project")).toStrictEqual([])
  })
})

// ── Codex ────────────────────────────────────────────────────────────────────

describe("codexServers", () => {
  /** Mirrors the real ~/.codex/config.toml shape, nested tables and all. */
  const TOML = `
model = "gpt-5"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"

[mcp_servers.wowlogs]
command = "node"
args = ["/repos/wowlogs-mcp/dist/server.js"]

[mcp_servers.wowlogs.env]
WARCRAFTLOGS_CLIENT_ID = "abc"
WARCRAFTLOGS_CLIENT_SECRET = "${SECRET}"

[mcp_servers.stitch]
url = "https://stitch.googleapis.com/mcp"

[mcp_servers.stitch.http_headers]
X-Goog-Api-Key = "${SECRET}"
`

  it("reads stdio servers with command and args joined", () => {
    const wowlogs = pub(codexServers(TOML)).find((s) => s.name === "wowlogs")
    expect(wowlogs?.transport).toBe("stdio")
    expect(wowlogs?.target).toBe("node /repos/wowlogs-mcp/dist/server.js")
    expect(wowlogs?.scope).toBe("user")
    expect(wowlogs?.cli).toBe("codex")
  })

  /** The reason for a real TOML parser: a regex cannot see a nested [x.env] table. */
  it("reads nested env tables as key names", () => {
    const wowlogs = pub(codexServers(TOML)).find((s) => s.name === "wowlogs")
    expect(wowlogs?.envKeys).toStrictEqual(["WARCRAFTLOGS_CLIENT_ID", "WARCRAFTLOGS_CLIENT_SECRET"])
  })

  it("reads nested http_headers tables as key names", () => {
    const stitch = pub(codexServers(TOML)).find((s) => s.name === "stitch")
    expect(stitch?.headerKeys).toStrictEqual(["X-Goog-Api-Key"])
    expect(stitch?.transport).toBe("http")
  })

  it("respects an explicit enabled = false", () => {
    expect(pub(codexServers(`[mcp_servers.x]\ncommand = "x"\nenabled = false\n`))[0]?.enabled).toBe(false)
  })

  it.each([
    ["empty string", ""],
    ["invalid toml", "[[[not toml"],
    ["no mcp_servers table", `model = "gpt-5"`],
    ["entry with neither command nor url", `[mcp_servers.x]\nnote = "hi"`]
  ])("yields [] for %s", (_label, raw) => {
    expect(codexServers(raw)).toStrictEqual([])
  })
})

// ── opencode ─────────────────────────────────────────────────────────────────

describe("opencodeServers", () => {
  it("reads a local server, splitting its argv command array", () => {
    const raw = JSON.stringify({
      mcp: { local: { type: "local", command: ["node", "server.js"], environment: { API_KEY: SECRET } } }
    })
    expect(pub(opencodeServers(raw, "user"))[0]).toStrictEqual({
      name: "local",
      cli: "opencode",
      transport: "stdio",
      scope: "user",
      target: "node server.js",
      envKeys: ["API_KEY"],
      headerKeys: [],
      enabled: true
    })
  })

  /** opencode's command is an argv array, so command[0] is the binary and the rest are args. */
  it("splits argv into command and args on the launch half", () => {
    const raw = JSON.stringify({ mcp: { l: { type: "local", command: ["node", "a.js", "--flag"] } } })
    const launch = opencodeServers(raw, "user")[0]?.launch
    expect(launch?.command).toBe("node")
    expect(launch?.args).toStrictEqual(["a.js", "--flag"])
  })

  it("reads a remote server with headers as key names", () => {
    const raw = JSON.stringify({
      mcp: { remote: { type: "remote", url: "https://x/mcp", headers: { Authorization: SECRET } } }
    })
    const servers = pub(opencodeServers(raw, "project"))
    expect(servers[0]?.transport).toBe("http")
    expect(servers[0]?.headerKeys).toStrictEqual(["Authorization"])
    expect(servers[0]?.scope).toBe("project")
  })

  /** opencode is the only harness with a first-class enabled flag in config. */
  it("respects enabled: false", () => {
    const raw = JSON.stringify({ mcp: { off: { type: "local", command: ["x"], enabled: false } } })
    expect(pub(opencodeServers(raw, "user"))[0]?.enabled).toBe(false)
  })

  it.each([
    ["empty string", ""],
    ["no mcp key", "{}"],
    ["local with empty command array", JSON.stringify({ mcp: { x: { type: "local", command: [] } } })],
    ["remote with no url", JSON.stringify({ mcp: { x: { type: "remote" } } })]
  ])("yields [] for %s", (_label, raw) => {
    expect(opencodeServers(raw, "user")).toStrictEqual([])
  })
})

// ── Scope merging ────────────────────────────────────────────────────────────

describe("mergeByScope", () => {
  const at = (scope: "user" | "project" | "local", name: string, target: string): ParsedMcpServer => ({
    server: {
      name,
      cli: "claude",
      transport: "stdio",
      scope,
      target,
      envKeys: [],
      headerKeys: [],
      enabled: true
    },
    launch: { transport: "stdio", command: target, args: [], env: {}, headers: {} }
  })

  it("lets project shadow user on a name clash", () => {
    const merged = pub(mergeByScope([[at("user", "linear", "user-cmd")], [at("project", "linear", "project-cmd")]]))
    expect(merged).toHaveLength(1)
    expect(merged[0]?.target).toBe("project-cmd")
    expect(merged[0]?.scope).toBe("project")
  })

  it("lets local shadow project, the highest precedence", () => {
    const merged = pub(mergeByScope([[at("project", "linear", "p")], [at("local", "linear", "l")]]))
    expect(merged[0]?.scope).toBe("local")
  })

  /** Precedence must come from scope, not argument order. */
  it("keeps the higher scope even when the lower one is listed last", () => {
    const merged = pub(mergeByScope([[at("local", "linear", "l")], [at("user", "linear", "u")]]))
    expect(merged[0]?.scope).toBe("local")
  })

  it("keeps distinct names from every scope and sorts them", () => {
    const merged = pub(mergeByScope([[at("user", "zebra", "z")], [at("project", "alpha", "a")]]))
    expect(merged.map((s) => s.name)).toStrictEqual(["alpha", "zebra"])
  })

  it("carries the winner's launch half, not the loser's", () => {
    const merged = mergeByScope([[at("user", "linear", "user-cmd")], [at("local", "linear", "local-cmd")]])
    expect(merged[0]?.launch.command).toBe("local-cmd")
  })

  it("yields [] for no groups", () => {
    expect(mergeByScope([])).toStrictEqual([])
  })
})

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * The tripwire. Each parser gets a config with a secret planted in every
 * value-bearing map. The renderer-facing half must never contain that value —
 * while the main-process-only launch half must still carry it, or the probe
 * would start every credentialled server without its credentials.
 */
describe("redaction — the public half never carries a secret value", () => {
  const withSecret = JSON.stringify({
    mcpServers: {
      stdio: { command: "srv", args: ["--flag"], env: { API_KEY: SECRET, OTHER: SECRET } },
      remote: { url: "https://x/mcp", headers: { Authorization: SECRET } }
    },
    projects: { "/repo": { mcpServers: { p: { command: "p", env: { P_KEY: SECRET } } } } },
    mcp: {
      l: { type: "local", command: ["n"], environment: { L_KEY: SECRET } },
      r: { type: "remote", url: "https://y", headers: { R_KEY: SECRET } }
    }
  })

  const codexToml = `[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.a.env]\nA_KEY = "${SECRET}"\n\n[mcp_servers.b]\nurl = "https://b"\n\n[mcp_servers.b.http_headers]\nB_KEY = "${SECRET}"\n`

  const CASES: ReadonlyArray<readonly [string, () => ReadonlyArray<ParsedMcpServer>]> = [
    ["claudeUserServers", () => claudeUserServers(withSecret)],
    ["claudeSettingsServers", () => claudeSettingsServers(withSecret)],
    ["claudeLocalServers", () => claudeLocalServers(withSecret, "/repo")],
    ["claudeProjectServers", () => claudeProjectServers(withSecret)],
    ["cursorServers", () => cursorServers(withSecret, "user")],
    ["codexServers", () => codexServers(codexToml)],
    ["opencodeServers", () => opencodeServers(withSecret, "user")]
  ]

  it.each(CASES)("%s emits key names but never values on the public half", (_label, run) => {
    const parsed = run()
    expect(parsed.length).toBeGreaterThan(0)
    const serialised = JSON.stringify(pub(parsed))
    expect(serialised).not.toContain(SECRET)
    // …and the names ARE present, so we know we parsed rather than dropped the map.
    expect(serialised).toMatch(/_KEY|API_KEY|Authorization/)
  })

  it.each(CASES)("%s keeps real values on the launch half, so probes can authenticate", (_label, run) => {
    const parsed = run()
    const values = parsed.flatMap((p) => [...Object.values(p.launch.env), ...Object.values(p.launch.headers)])
    expect(values).toContain(SECRET)
  })
})
