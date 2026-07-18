import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpService } from "./mcp.js"
import { mkTemp } from "./test-support.js"

const FAKE_SERVER = fileURLToPath(new URL("./mcp-fixtures/fake-mcp-server.mjs", import.meta.url))

let home: ReturnType<typeof mkTemp>
let repo: ReturnType<typeof mkTemp>

beforeEach(() => {
  home = mkTemp("starbase-mcp-home-")
  repo = mkTemp("starbase-mcp-repo-")
})
afterEach(() => {
  home.cleanup()
  repo.cleanup()
})

const run = <A>(effect: Effect.Effect<A, never, McpService | NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(McpService.Default, NodeContext.layer))))

/** Write a file, creating parent dirs — fixtures are plain node:fs, not Effect FS. */
const write = (root: string, rel: string, body: unknown) => {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body))
}

describe("McpService.list — claude", () => {
  it("merges all four config sources with local winning a name clash", async () => {
    write(home.dir, ".claude.json", {
      mcpServers: { obsidian: { command: "obsidian-mcp" }, shared: { command: "from-user" } },
      projects: { [repo.dir]: { mcpServers: { shared: { command: "from-local" } } } }
    })
    write(home.dir, ".claude/settings.json", {
      mcpServers: { fromSettings: { url: "https://settings/mcp" } },
      enableAllProjectMcpServers: true
    })
    write(repo.dir, ".mcp.json", { mcpServers: { fromProject: { command: "project-mcp" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]))

    expect(Object.keys(byName).sort()).toStrictEqual(["fromProject", "fromSettings", "obsidian", "shared"])
    expect(byName.obsidian?.scope).toBe("user")
    expect(byName.fromSettings?.scope).toBe("user")
    expect(byName.fromProject?.scope).toBe("project")
    // local (projects[<path>]) outranks the user-scope entry of the same name
    expect(byName.shared?.scope).toBe("local")
    expect(byName.shared?.target).toBe("from-local")
  })

  /**
   * The mainstream approval flow. Claude records `.mcp.json` approvals in the repo's
   * `.claude/settings.local.json` and in `~/.claude.json` under `projects[<cwd>]` —
   * NOT in `~/.claude/settings.json`. Reading only the latter (which in a real
   * install carries none of these keys) made every project server render
   * "not enabled" and report `disabled` without ever probing.
   */
  it("honours enableAllProjectMcpServers from the repo's .claude/settings.local.json", async () => {
    write(home.dir, ".claude/settings.json", {})
    write(repo.dir, ".claude/settings.local.json", { enableAllProjectMcpServers: true })
    write(repo.dir, ".mcp.json", { mcpServers: { linear: { command: "l" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers.map((s) => [s.name, s.enabled])).toStrictEqual([["linear", true]])
  })

  it("honours enabledMcpjsonServers from the repo's .claude/settings.local.json", async () => {
    write(repo.dir, ".claude/settings.local.json", { enabledMcpjsonServers: ["linear"] })
    write(repo.dir, ".mcp.json", { mcpServers: { linear: { command: "l" }, other: { command: "o" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(Object.fromEntries(servers.map((s) => [s.name, s.enabled]))).toStrictEqual({
      linear: true,
      other: false
    })
  })

  it("honours approvals recorded in ~/.claude.json under projects[worktree]", async () => {
    write(home.dir, ".claude.json", { projects: { [repo.dir]: { enabledMcpjsonServers: ["linear"] } } })
    write(repo.dir, ".mcp.json", { mcpServers: { linear: { command: "l" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers.map((s) => [s.name, s.enabled])).toStrictEqual([["linear", true]])
  })

  it("honours the repo's committed .claude/settings.json too", async () => {
    write(repo.dir, ".claude/settings.json", { enableAllProjectMcpServers: true })
    write(repo.dir, ".mcp.json", { mcpServers: { linear: { command: "l" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers[0]?.enabled).toBe(true)
  })

  /**
   * `disabledMcpServers` is a separate, per-project list that turns a server off
   * whatever scope defined it — the operator's real config uses it on user-scope
   * servers, which would otherwise show as on.
   */
  it("disables a user-scope server listed in the project's disabledMcpServers", async () => {
    write(home.dir, ".claude.json", {
      mcpServers: { obsidian: { command: "o" }, linear: { command: "l" } },
      projects: { [repo.dir]: { disabledMcpServers: ["obsidian"] } }
    })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(Object.fromEntries(servers.map((s) => [s.name, s.enabled]))).toStrictEqual({
      obsidian: false,
      linear: true
    })
  })

  it("surfaces an unapproved project server as disabled rather than hiding it", async () => {
    write(home.dir, ".claude/settings.json", {})
    write(repo.dir, ".mcp.json", { mcpServers: { pending: { command: "p" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers.map((s) => [s.name, s.enabled])).toStrictEqual([["pending", false]])
  })

  /** Settings has no session, so project/local sources must simply not be consulted. */
  it("returns user scope only when there is no worktree", async () => {
    write(home.dir, ".claude.json", {
      mcpServers: { obsidian: { command: "obsidian-mcp" } },
      projects: { [repo.dir]: { mcpServers: { local: { command: "l" } } } }
    })
    write(repo.dir, ".mcp.json", { mcpServers: { fromProject: { command: "p" } } })

    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: null }))
    expect(servers.map((s) => s.name)).toStrictEqual(["obsidian"])
  })

  it("yields [] when nothing is configured", async () => {
    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers).toStrictEqual([])
  })

  it("yields [] rather than failing on a malformed config", async () => {
    write(home.dir, ".claude.json", "{ not json at all")
    const servers = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: null }))
    expect(servers).toStrictEqual([])
  })

  it("tolerates a null homeDir", async () => {
    const servers = await run(McpService.list({ cli: "claude", homeDir: null, worktreePath: null }))
    expect(servers).toStrictEqual([])
  })
})

describe("McpService.list — cursor", () => {
  it("merges user and project mcp.json with project winning", async () => {
    write(home.dir, ".cursor/mcp.json", { mcpServers: { posthog: { url: "https://user/mcp" }, only: { url: "https://u" } } })
    write(repo.dir, ".cursor/mcp.json", { mcpServers: { posthog: { url: "https://project/mcp" } } })

    const servers = await run(McpService.list({ cli: "cursor", homeDir: home.dir, worktreePath: repo.dir }))
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
    expect(byName.posthog?.scope).toBe("project")
    expect(byName.posthog?.target).toBe("https://project/mcp")
    expect(byName.only?.scope).toBe("user")
  })
})

describe("McpService.list — codex", () => {
  it("reads user-scope servers from config.toml including nested env keys", async () => {
    write(
      home.dir,
      ".codex/config.toml",
      `[mcp_servers.wowlogs]\ncommand = "node"\nargs = ["srv.js"]\n\n[mcp_servers.wowlogs.env]\nSECRET_KEY = "sk-live-nope"\n`
    )
    const servers = await run(McpService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers).toHaveLength(1)
    expect(servers[0]?.envKeys).toStrictEqual(["SECRET_KEY"])
    expect(JSON.stringify(servers)).not.toContain("sk-live-nope")
  })

  /** Codex has no project-scope MCP config; a .mcp.json in the repo must be ignored for it. */
  it("ignores project config, which codex does not support", async () => {
    write(repo.dir, ".mcp.json", { mcpServers: { p: { command: "p" } } })
    const servers = await run(McpService.list({ cli: "codex", homeDir: home.dir, worktreePath: repo.dir }))
    expect(servers).toStrictEqual([])
  })
})

describe("McpService.list — opencode", () => {
  it("merges user and project opencode.json in opencode's own mcp shape", async () => {
    write(home.dir, ".config/opencode/opencode.json", {
      mcp: { zen: { type: "local", command: ["opencode-zen"], environment: { ZEN_KEY: "secret-zen" } } }
    })
    write(repo.dir, "opencode.json", { mcp: { proj: { type: "remote", url: "https://p/mcp" } } })

    const servers = await run(McpService.list({ cli: "opencode", homeDir: home.dir, worktreePath: repo.dir }))
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
    expect(byName.zen?.scope).toBe("user")
    expect(byName.zen?.target).toBe("opencode-zen")
    expect(byName.zen?.envKeys).toStrictEqual(["ZEN_KEY"])
    expect(byName.proj?.scope).toBe("project")
    expect(JSON.stringify(servers)).not.toContain("secret-zen")
  })
})

describe("McpService.status", () => {
  /**
   * A run-count marker: the fake server appends a line to this file on start, so a
   * cached read can be distinguished from a re-probe by counting spawns.
   */
  const fakeConfig = (mode: ReadonlyArray<string>) => ({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_SERVER, ...mode] } }
  })

  it("probes a configured server and reports connected with a tool count", async () => {
    write(home.dir, ".claude.json", fakeConfig(["ok", "4"]))
    const statuses = await run(McpService.status({ cli: "claude", homeDir: home.dir, worktreePath: null }))
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.name).toBe("fake")
    expect(statuses[0]?.state).toBe("connected")
    expect(statuses[0]?.toolCount).toBe(4)
    expect(statuses[0]?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  /**
   * The cache lives on the service instance, so both reads must happen inside one
   * effect — a second `run()` would build a fresh layer and a fresh cache. That
   * mirrors the app, where `AppLayer` holds a single `McpService`.
   */
  it("reuses the cached result on a second read rather than re-probing", async () => {
    write(home.dir, ".claude.json", fakeConfig(["ok", "2"]))
    const spec = { cli: "claude" as const, homeDir: home.dir, worktreePath: null }

    const [first, second] = await run(
      Effect.gen(function* () {
        const a = yield* McpService.status(spec)
        // Swap the config so a re-probe would yield a different tool count.
        write(home.dir, ".claude.json", fakeConfig(["ok", "9"]))
        const b = yield* McpService.status(spec)
        return [a, b] as const
      })
    )

    expect(first[0]?.toolCount).toBe(2)
    expect(second[0]?.toolCount).toBe(2)
    expect(second[0]?.checkedAt).toBe(first[0]?.checkedAt)
  })

  it("re-probes when refresh is set, picking up the new result", async () => {
    write(home.dir, ".claude.json", fakeConfig(["ok", "2"]))
    const spec = { cli: "claude" as const, homeDir: home.dir, worktreePath: null }

    const [first, refreshed] = await run(
      Effect.gen(function* () {
        const a = yield* McpService.status(spec)
        write(home.dir, ".claude.json", fakeConfig(["ok", "9"]))
        const b = yield* McpService.status(spec, { refresh: true })
        return [a, b] as const
      })
    )

    expect(first[0]?.toolCount).toBe(2)
    expect(refreshed[0]?.toolCount).toBe(9)
  })

  /**
   * McpService is a singleton in `AppLayer`, so every session shares one cache.
   * Two repos routinely have a project-scope server of the SAME NAME pointing at
   * different commands; keying on `cli:scope:name` alone served repo A's status for
   * repo B's server, and repo B's real server was never probed.
   */
  it("does not share a cached status between two worktrees using the same server name", async () => {
    const other = mkTemp("starbase-mcp-repo2-")
    try {
      write(home.dir, ".claude/settings.json", { enableAllProjectMcpServers: true })
      // Same name, different tool counts — so a collision is visible in the result.
      write(repo.dir, ".mcp.json", {
        mcpServers: { shared: { command: process.execPath, args: [FAKE_SERVER, "ok", "2"] } }
      })
      write(other.dir, ".mcp.json", {
        mcpServers: { shared: { command: process.execPath, args: [FAKE_SERVER, "ok", "7"] } }
      })

      const [first, second] = await run(
        Effect.gen(function* () {
          const a = yield* McpService.status({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir })
          const b = yield* McpService.status({ cli: "claude", homeDir: home.dir, worktreePath: other.dir })
          return [a, b] as const
        })
      )

      expect(first[0]?.toolCount).toBe(2)
      // Would be 2 if the second worktree hit the first's cache entry.
      expect(second[0]?.toolCount).toBe(7)
    } finally {
      other.cleanup()
    }
  })

  it("still caches within a single worktree", async () => {
    write(home.dir, ".claude.json", fakeConfig(["ok", "2"]))
    const spec = { cli: "claude" as const, homeDir: home.dir, worktreePath: repo.dir }

    const [first, second] = await run(
      Effect.gen(function* () {
        const a = yield* McpService.status(spec)
        write(home.dir, ".claude.json", fakeConfig(["ok", "9"]))
        const b = yield* McpService.status(spec)
        return [a, b] as const
      })
    )
    expect(first[0]?.toolCount).toBe(2)
    expect(second[0]?.toolCount).toBe(2)
  })

  it("reports a broken server as failed without failing the call", async () => {
    write(home.dir, ".claude.json", fakeConfig(["crash"]))
    const statuses = await run(McpService.status({ cli: "claude", homeDir: home.dir, worktreePath: null }))
    expect(statuses[0]?.state).toBe("failed")
    expect(statuses[0]?.error).toBeTruthy()
  })

  it("returns [] when nothing is configured", async () => {
    expect(await run(McpService.status({ cli: "claude", homeDir: home.dir, worktreePath: null }))).toStrictEqual([])
  })

  /** Statuses must line up with `list` so the UI can join them by name and scope. */
  it("returns one status per listed server, in the same order", async () => {
    write(home.dir, ".claude.json", {
      mcpServers: {
        zebra: { command: process.execPath, args: [FAKE_SERVER, "ok", "1"] },
        alpha: { command: process.execPath, args: [FAKE_SERVER, "ok", "1"] }
      }
    })
    const spec = { cli: "claude" as const, homeDir: home.dir, worktreePath: null }
    const servers = await run(McpService.list(spec))
    const statuses = await run(McpService.status(spec))
    expect(statuses.map((s) => s.name)).toStrictEqual(servers.map((s) => s.name))
    expect(statuses.map((s) => s.scope)).toStrictEqual(servers.map((s) => s.scope))
  })

  it("marks an unapproved project server disabled instead of probing it", async () => {
    write(home.dir, ".claude/settings.json", {})
    write(repo.dir, ".mcp.json", { mcpServers: { pending: { command: process.execPath, args: [FAKE_SERVER, "crash"] } } })
    const statuses = await run(McpService.status({ cli: "claude", homeDir: home.dir, worktreePath: repo.dir }))
    expect(statuses[0]?.state).toBe("disabled")
  })
})

describe("McpService.list — cross-harness isolation", () => {
  /** Each harness reads only its own files; a claude config must not leak into a codex session. */
  it("does not report claude's servers for a codex session", async () => {
    write(home.dir, ".claude.json", { mcpServers: { obsidian: { command: "obsidian-mcp" } } })
    const codex = await run(McpService.list({ cli: "codex", homeDir: home.dir, worktreePath: null }))
    expect(codex).toStrictEqual([])
    const claude = await run(McpService.list({ cli: "claude", homeDir: home.dir, worktreePath: null }))
    expect(claude).toHaveLength(1)
  })

  it("stamps every server with the harness it came from", async () => {
    write(home.dir, ".cursor/mcp.json", { mcpServers: { a: { url: "https://a" } } })
    const servers = await run(McpService.list({ cli: "cursor", homeDir: home.dir, worktreePath: null }))
    expect(servers[0]?.cli).toBe("cursor")
  })
})
