import type { CliKind, McpServer, McpServerStatus } from "@starbase/core"
import { mcpServerKey } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Ref } from "effect"
import { probeAll } from "./mcp-probe.js"
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

/** What harness a `list` request is scoped to, and where to look for its config. */
export interface McpSpec {
  readonly cli: CliKind
  /**
   * The operator's REAL home dir (never `STARBASE_HOME`) — harness config lives
   * under `~`, not under Starbase's own state dir. Passed in rather than read here
   * so the service stays home-agnostic and testable.
   */
  readonly homeDir: string | null
  /** The session's worktree, for project/local scope; null in session-free contexts (Settings). */
  readonly worktreePath: string | null
}

type ScanEnv = FileSystem.FileSystem | Path.Path

/**
 * Reads the MCP servers each harness will actually load.
 *
 * Best-effort throughout: the error channel is `never` and every read falls back
 * to `""`, so a missing or malformed config yields no servers rather than breaking
 * the Settings pane or the composer. A harness we can't read is indistinguishable
 * from one with nothing configured, which is the honest answer either way.
 */
export class McpService extends Effect.Service<McpService>()("@starbase/McpService", {
  accessors: true,
  effect: Effect.gen(function* () {
    /** Probe results, keyed `cli:scope:name`. Survives dialog open/close; cleared by refresh. */
    const cache = yield* Ref.make(new Map<string, McpServerStatus>())

    /** Injectable clock so tests can assert on `checkedAt` without freezing time globally. */
    const now = () => new Date().toISOString()

    /**
     * The full parse, including each server's secret-bearing `launch` half.
     * Internal on purpose — only `list` (redacted) crosses the RPC boundary, while
     * the probe in `status` needs the launch half to authenticate.
     */
    const parse = (spec: McpSpec): Effect.Effect<ReadonlyArray<ParsedMcpServer>, never, ScanEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const read = (p: string) => fs.readFileString(p).pipe(Effect.orElseSucceed(() => ""))

        const home = spec.homeDir
        const work = spec.worktreePath

        if (spec.cli === "claude") {
          // Four sources, not two. `~/.claude.json` carries BOTH the user-scope map
          // and the per-project (local) one; `~/.claude/settings.json` adds more user
          // servers and owns the approval gate for project `.mcp.json` servers.
          const claudeJson = home ? yield* read(path.join(home, ".claude.json")) : ""
          const settings = home ? yield* read(path.join(home, ".claude", "settings.json")) : ""
          const projectJson = work ? yield* read(path.join(work, ".mcp.json")) : ""
          const gate = claudeProjectGate(settings)
          return mergeByScope([
            claudeUserServers(claudeJson),
            claudeSettingsServers(settings),
            claudeProjectServers(projectJson, gate),
            work ? claudeLocalServers(claudeJson, work) : []
          ])
        }

        if (spec.cli === "cursor") {
          const user = home ? yield* read(path.join(home, ".cursor", "mcp.json")) : ""
          const project = work ? yield* read(path.join(work, ".cursor", "mcp.json")) : ""
          return mergeByScope([cursorServers(user, "user"), cursorServers(project, "project")])
        }

        if (spec.cli === "codex") {
          // Codex has no project-scope MCP config — user scope is the whole story.
          const user = home ? yield* read(path.join(home, ".codex", "config.toml")) : ""
          return mergeByScope([codexServers(user)])
        }

        const user = home ? yield* read(path.join(home, ".config", "opencode", "opencode.json")) : ""
        const project = work ? yield* read(path.join(work, "opencode.json")) : ""
        return mergeByScope([opencodeServers(user, "user"), opencodeServers(project, "project")])
      })

    /** The redacted list — this is what the RPC returns. */
    const list = (spec: McpSpec): Effect.Effect<ReadonlyArray<McpServer>, never, ScanEnv> =>
      parse(spec).pipe(Effect.map((parsed) => parsed.map((p) => p.server)))

    /**
     * Live status for every configured server.
     *
     * Probing spawns processes and hits the network, so results are cached per
     * `cli:scope:name` and reused until the operator explicitly refreshes. Opening
     * the dialog twice should not restart every server.
     */
    const status = (
      spec: McpSpec,
      opts: { readonly refresh?: boolean } = {}
    ): Effect.Effect<ReadonlyArray<McpServerStatus>, never, ScanEnv> =>
      Effect.gen(function* () {
        const parsed = yield* parse(spec)
        const cached = yield* Ref.get(cache)

        const keyOf = (entry: ParsedMcpServer) => `${spec.cli}:${mcpServerKey(entry.server.scope, entry.server.name)}`
        const hit = (entry: ParsedMcpServer) => (opts.refresh === true ? undefined : cached.get(keyOf(entry)))

        const stale = parsed.filter((entry) => hit(entry) === undefined)
        const fresh = yield* probeAll(stale, spec.worktreePath, now)

        const freshByKey = new Map(stale.map((entry, i) => [keyOf(entry), fresh[i]!] as const))
        yield* Ref.update(cache, (m) => {
          const next = new Map(m)
          for (const [k, v] of freshByKey) next.set(k, v)
          return next
        })

        // Input order, so the UI list doesn't reshuffle between a cached and a fresh read.
        return parsed.map((entry) => hit(entry) ?? freshByKey.get(keyOf(entry))!)
      })

    return { list, parse, status }
  })
}) {}
