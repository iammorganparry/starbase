import type { CliKind, McpScope, McpServer, McpTransport } from "@starbase/core"
import { parse as parseToml } from "smol-toml"

/**
 * Pure parsers for each harness's *own* MCP config. Starbase does not define an
 * MCP format — it reads what `claude` / `codex` / `cursor` / `opencode` already
 * load, so what the UI shows is what the agent will actually get.
 *
 * Every function here is `string -> ReadonlyArray<ParsedMcpServer>` and total:
 * malformed or absent input yields `[]`, never a throw. IO lives in `mcp.ts`.
 *
 * SECURITY — the split at the heart of this module. Real configs carry API keys
 * in `env` / `http_headers` (see `~/.codex/config.toml`), and two things need
 * different halves of that:
 *
 *   - the UI needs to *describe* a server  → `ParsedMcpServer.server` (`McpServer`),
 *     which carries key NAMES only and is the only half that crosses the RPC boundary;
 *   - the probe needs to *launch* a server → `ParsedMcpServer.launch`, which carries
 *     the real values and must never leave the main process.
 *
 * Probing from the redacted half would start every env-dependent server without its
 * credentials and report a false "failed", which is why the two are separated here
 * rather than at the call site.
 */

/** Everything needed to actually connect to a server. Main-process only — contains secrets. */
export interface McpLaunch {
  readonly transport: McpTransport
  /** stdio only. */
  readonly command?: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** remote only. */
  readonly url?: string
  readonly headers: Readonly<Record<string, string>>
}

/** A config entry, split into its safe-to-send half and its secret-bearing half. */
export interface ParsedMcpServer {
  /** Redacted. Safe to send to the renderer. */
  readonly server: McpServer
  /** Secrets. Never send this anywhere. */
  readonly launch: McpLaunch
}

const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The only place a secret-bearing map is read for its VALUES. */
const stringMap = (v: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val
  return out
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const strArray = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/**
 * A remote server's declared transport. Claude/Cursor use `type: "http" | "sse"`;
 * anything with a URL but no explicit type is treated as streamable HTTP, which is
 * what those harnesses default to.
 */
const remoteTransport = (type: unknown): McpTransport => (str(type) === "sse" ? "sse" : "http")

/**
 * A remote server's URL, safe to display: origin + path, with the query string and
 * fragment dropped.
 *
 * MCP URLs routinely carry credentials as query params (`?project_ref=…`, and API
 * keys are commonly passed the same way), and `target` is sent to the renderer — so
 * the query is treated as secret-bearing like `env` and `headers`. The full URL is
 * preserved on the launch half, which is what actually connects.
 */
const displayUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url)
    return `${parsedUrl.origin}${parsedUrl.pathname}`
  } catch {
    // Not a parseable URL — drop everything from the first `?` OR `#` rather than
    // guess. Splitting on `?` alone would let `not-a-url#token=SECRET` through, a
    // hole in the one rule this function exists to enforce.
    return url.split(/[?#]/)[0] ?? url
  }
}

/** Build both halves from already-extracted pieces, so redaction happens in exactly one place. */
const parsed = (args: {
  readonly name: string
  readonly cli: CliKind
  readonly scope: McpScope
  readonly enabled: boolean
  readonly transport: McpTransport
  readonly command?: string
  readonly argv?: ReadonlyArray<string>
  readonly url?: string
  readonly env?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
}): ParsedMcpServer => {
  const env = args.env ?? {}
  const headers = args.headers ?? {}
  const argv = args.argv ?? []
  return {
    server: {
      name: args.name,
      cli: args.cli,
      transport: args.transport,
      scope: args.scope,
      target:
        args.url !== undefined
          ? displayUrl(args.url)
          : [args.command ?? "", ...argv].filter((s) => s.length > 0).join(" "),
      envKeys: Object.keys(env),
      headerKeys: Object.keys(headers),
      enabled: args.enabled
    },
    launch: {
      transport: args.transport,
      command: args.command,
      args: argv,
      env,
      url: args.url,
      headers
    }
  }
}

/**
 * The `{ "name": { command | url, ... } }` shape shared by Claude Code, Cursor and
 * (project-scope) `.mcp.json`. One parser covers all of them because the harnesses
 * deliberately use the same schema.
 */
const parseMcpServersMap = (
  map: unknown,
  cli: CliKind,
  scope: McpScope,
  opts: { readonly isEnabled?: (name: string) => boolean } = {}
): ReadonlyArray<ParsedMcpServer> => {
  if (!isRecord(map)) return []
  const out: Array<ParsedMcpServer> = []
  for (const [name, raw] of Object.entries(map)) {
    if (!isRecord(raw)) continue
    const url = str(raw.url)
    const command = str(raw.command)
    // A server must say how to reach it; anything else is a malformed entry.
    if (url === undefined && command === undefined) continue
    const enabled = opts.isEnabled?.(name) ?? true
    out.push(
      url !== undefined
        ? parsed({
            name,
            cli,
            scope,
            enabled,
            transport: remoteTransport(raw.type),
            url,
            env: stringMap(raw.env),
            headers: stringMap(raw.headers)
          })
        : parsed({
            name,
            cli,
            scope,
            enabled,
            transport: "stdio",
            command,
            argv: strArray(raw.args),
            env: stringMap(raw.env)
          })
    )
  }
  return out
}

/**
 * One settings source's MCP approval flags, exactly as written in that file.
 *
 * Claude requires the operator to approve project (`.mcp.json`) servers before it
 * will load them: `enableAllProjectMcpServers` blanket-approves, otherwise
 * `enabledMcpjsonServers` allow-lists and `disabledMcpjsonServers` deny-lists. A
 * server nobody has approved is surfaced as `enabled: false` rather than hidden —
 * the operator needs to see why it is inert.
 *
 * These flags are spread across FOUR files (see `claudeGateSources` in `mcp.ts`).
 * Reading only `~/.claude/settings.json` is wrong in the mainstream flow: approving
 * a server at the interactive prompt writes to `~/.claude.json` under
 * `projects[<cwd>]`, and hand-edited approvals usually land in the repo's
 * `.claude/settings.local.json`.
 */
export interface ClaudeProjectGate {
  readonly enableAll: boolean
  readonly enabled: ReadonlyArray<string>
  readonly disabled: ReadonlyArray<string>
  /**
   * `disabledMcpServers` — turns a server off regardless of which scope defined it,
   * which is what Claude writes when a server is toggled off for a project. Distinct
   * from `disabledMcpjsonServers`, which only withholds approval from `.mcp.json`
   * servers. Without this, a user-scope server the operator has switched off still
   * shows as on.
   */
  readonly disabledAnyScope: ReadonlyArray<string>
}

/** A gate that decides nothing — the neutral element when a source is absent. */
export const EMPTY_CLAUDE_GATE: ClaudeProjectGate = {
  enableAll: false,
  enabled: [],
  disabled: [],
  disabledAnyScope: []
}

/** Read the approval flags out of one Claude settings file. */
export const claudeProjectGate = (settingsJson: string): ClaudeProjectGate => {
  const root = json(settingsJson)
  return isRecord(root) ? gateFrom(root) : EMPTY_CLAUDE_GATE
}

const gateFrom = (root: Record<string, unknown>): ClaudeProjectGate => ({
  enableAll: root.enableAllProjectMcpServers === true,
  enabled: strArray(root.enabledMcpjsonServers),
  disabled: strArray(root.disabledMcpjsonServers),
  disabledAnyScope: strArray(root.disabledMcpServers)
})

/**
 * `~/.claude.json` → `projects[<path>]`, which is where Claude records approvals
 * made at the interactive prompt. The single most important source, and the one a
 * naive implementation misses entirely.
 */
export const claudeProjectGateFor = (claudeJson: string, projectPath: string): ClaudeProjectGate => {
  const root = json(claudeJson)
  if (!isRecord(root) || !isRecord(root.projects)) return EMPTY_CLAUDE_GATE
  const project = root.projects[projectPath]
  return isRecord(project) ? gateFrom(project) : EMPTY_CLAUDE_GATE
}

/** Per-server decisions after folding every source in precedence order. */
export interface ResolvedClaudeGate {
  readonly enableAll: boolean
  readonly decisions: ReadonlyMap<string, boolean>
  readonly disabledAnyScope: ReadonlySet<string>
}

/**
 * Fold gate sources in ASCENDING precedence — later sources override earlier ones
 * per server, which is how Claude layers user → project → local → per-project
 * settings. Within one source a deny still beats an allow.
 */
export const mergeClaudeGates = (sources: ReadonlyArray<ClaudeProjectGate>): ResolvedClaudeGate => {
  let enableAll = false
  const decisions = new Map<string, boolean>()
  const disabledAnyScope = new Set<string>()
  for (const source of sources) {
    if (source.enableAll) enableAll = true
    for (const name of source.enabled) decisions.set(name, true)
    // Applied after `enabled`, so a name in both lists resolves to denied.
    for (const name of source.disabled) decisions.set(name, false)
    for (const name of source.disabledAnyScope) disabledAnyScope.add(name)
  }
  return { enableAll, decisions, disabledAnyScope }
}

const gateAllows = (gate: ResolvedClaudeGate | undefined, name: string): boolean => {
  if (gate === undefined) return true
  return gate.decisions.get(name) ?? gate.enableAll
}

/**
 * Apply `disabledMcpServers` across every scope. Runs after the scopes are merged,
 * because this list disables by name irrespective of where the server was defined.
 */
export const applyDisabledAnyScope = (
  servers: ReadonlyArray<ParsedMcpServer>,
  disabled: ReadonlySet<string>
): ReadonlyArray<ParsedMcpServer> =>
  disabled.size === 0
    ? servers
    : servers.map((entry) =>
        disabled.has(entry.server.name) ? { ...entry, server: { ...entry.server, enabled: false } } : entry
      )

// ── Claude Code ──────────────────────────────────────────────────────────────

/** `~/.claude.json` → top-level `mcpServers` (user scope). */
export const claudeUserServers = (claudeJson: string): ReadonlyArray<ParsedMcpServer> => {
  const root = json(claudeJson)
  return isRecord(root) ? parseMcpServersMap(root.mcpServers, "claude", "user") : []
}

/** `~/.claude/settings.json` → `mcpServers` (also user scope). */
export const claudeSettingsServers = (settingsJson: string): ReadonlyArray<ParsedMcpServer> => {
  const root = json(settingsJson)
  return isRecord(root) ? parseMcpServersMap(root.mcpServers, "claude", "user") : []
}

/**
 * `~/.claude.json` → `projects[<path>].mcpServers` (local scope).
 *
 * GOTCHA: Starbase sessions run in git worktrees, so `projectPath` is the *worktree*
 * path. Servers the operator registered against the original checkout will not match
 * and will not appear — correctly, since Claude keys off cwd the same way.
 */
export const claudeLocalServers = (claudeJson: string, projectPath: string): ReadonlyArray<ParsedMcpServer> => {
  const root = json(claudeJson)
  if (!isRecord(root) || !isRecord(root.projects)) return []
  const project = root.projects[projectPath]
  return isRecord(project) ? parseMcpServersMap(project.mcpServers, "claude", "local") : []
}

/** `<root>/.mcp.json` (project scope), gated by the operator's approvals. */
export const claudeProjectServers = (
  mcpJson: string,
  gate?: ResolvedClaudeGate
): ReadonlyArray<ParsedMcpServer> => {
  const root = json(mcpJson)
  if (!isRecord(root)) return []
  return parseMcpServersMap(root.mcpServers, "claude", "project", {
    isEnabled: (name) => gateAllows(gate, name)
  })
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/** `~/.cursor/mcp.json` or `<root>/.cursor/mcp.json` — same shape, differing scope. */
export const cursorServers = (mcpJson: string, scope: McpScope): ReadonlyArray<ParsedMcpServer> => {
  const root = json(mcpJson)
  return isRecord(root) ? parseMcpServersMap(root.mcpServers, "cursor", scope) : []
}

// ── Codex ────────────────────────────────────────────────────────────────────

/**
 * `~/.codex/config.toml` → `[mcp_servers.<name>]`, with nested `[mcp_servers.<name>.env]`
 * and `[...].http_headers` tables.
 *
 * A real TOML parser is required here: `default-mode.ts` reads this file with a regex,
 * which cannot see nested tables and would silently miss env/header keys.
 *
 * Codex has no project-scope MCP config, so everything here is user scope.
 */
export const codexServers = (configToml: string): ReadonlyArray<ParsedMcpServer> => {
  let root: unknown
  try {
    root = parseToml(configToml)
  } catch {
    return []
  }
  if (!isRecord(root) || !isRecord(root.mcp_servers)) return []
  const out: Array<ParsedMcpServer> = []
  for (const [name, raw] of Object.entries(root.mcp_servers)) {
    if (!isRecord(raw)) continue
    const url = str(raw.url)
    const command = str(raw.command)
    if (url === undefined && command === undefined) continue
    const enabled = raw.enabled !== false
    out.push(
      url !== undefined
        ? parsed({
            name,
            cli: "codex",
            scope: "user",
            enabled,
            transport: remoteTransport(raw.type),
            url,
            env: stringMap(raw.env),
            headers: stringMap(raw.http_headers)
          })
        : parsed({
            name,
            cli: "codex",
            scope: "user",
            enabled,
            transport: "stdio",
            command,
            argv: strArray(raw.args),
            env: stringMap(raw.env)
          })
    )
  }
  return out
}

// ── opencode ─────────────────────────────────────────────────────────────────

/**
 * `~/.config/opencode/opencode.json` or `<root>/opencode.json` → `mcp`.
 *
 * opencode uses its own shape (`McpLocalConfig` / `McpRemoteConfig` in its SDK):
 * `type: "local"` with `command` as an argv *array* and env under `environment`,
 * or `type: "remote"` with `url` and `headers`. It is also the only harness with a
 * first-class `enabled` flag in config.
 */
export const opencodeServers = (configJson: string, scope: McpScope): ReadonlyArray<ParsedMcpServer> => {
  const root = json(configJson)
  if (!isRecord(root) || !isRecord(root.mcp)) return []
  const out: Array<ParsedMcpServer> = []
  for (const [name, raw] of Object.entries(root.mcp)) {
    if (!isRecord(raw)) continue
    const enabled = raw.enabled !== false
    if (raw.type === "remote") {
      const url = str(raw.url)
      if (url === undefined) continue
      out.push(
        parsed({
          name,
          cli: "opencode",
          scope,
          enabled,
          transport: "http",
          url,
          headers: stringMap(raw.headers)
        })
      )
      continue
    }
    const argv = strArray(raw.command)
    if (argv.length === 0) continue
    out.push(
      parsed({
        name,
        cli: "opencode",
        scope,
        enabled,
        transport: "stdio",
        command: argv[0],
        argv: argv.slice(1),
        env: stringMap(raw.environment)
      })
    )
  }
  return out
}

// ── Scope merging ────────────────────────────────────────────────────────────

const PRECEDENCE: Record<McpScope, number> = { user: 0, project: 1, local: 2 }

/**
 * Merge servers from several scopes, highest precedence winning on a name clash
 * (`local` > `project` > `user`) — mirroring how the harnesses themselves resolve
 * a duplicate name. Sorted by name so the UI order is stable across refreshes.
 */
export const mergeByScope = (
  groups: ReadonlyArray<ReadonlyArray<ParsedMcpServer>>
): ReadonlyArray<ParsedMcpServer> => {
  const winner = new Map<string, ParsedMcpServer>()
  for (const entry of groups.flat()) {
    const held = winner.get(entry.server.name)
    if (held === undefined || PRECEDENCE[entry.server.scope] >= PRECEDENCE[held.server.scope]) {
      winner.set(entry.server.name, entry)
    }
  }
  return [...winner.values()].sort((a, b) => a.server.name.localeCompare(b.server.name))
}
