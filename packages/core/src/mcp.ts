import { Schema } from "effect"
import { CliKind } from "./domain.js"

/**
 * MCP (Model Context Protocol) servers, as configured in the *harness's own*
 * config files. Starbase never defines an MCP format of its own — it reads what
 * `claude` / `codex` / `cursor` / `opencode` already load, and reports it back.
 */

/** How a server is reached. `stdio` spawns a command; the rest are remote URLs. */
export const McpTransport = Schema.Literal("stdio", "http", "sse")
export type McpTransport = Schema.Schema.Type<typeof McpTransport>

/**
 * Which config file a server came from, in ascending precedence.
 *
 * - `user` — the operator's global config (e.g. `~/.claude.json`, `~/.codex/config.toml`).
 * - `project` — committed to the repo (e.g. `<root>/.mcp.json`, `<root>/.cursor/mcp.json`).
 * - `local` — this machine's per-project overrides (`~/.claude.json` → `projects[<path>]`).
 */
export const McpScope = Schema.Literal("user", "project", "local")
export type McpScope = Schema.Schema.Type<typeof McpScope>

/** The result of probing a server: did it actually answer an MCP handshake? */
export const McpServerState = Schema.Literal("unknown", "connected", "failed", "disabled")
export type McpServerState = Schema.Schema.Type<typeof McpServerState>

/**
 * One configured MCP server.
 *
 * SECURITY: this type is the redaction contract. Real configs carry API keys in
 * `env` and `http_headers` (see `~/.codex/config.toml`), so this struct carries
 * only *names* — `envKeys`, `headerKeys` — and never a value. Leaking a secret to
 * the renderer would require changing this schema, which is the point.
 */
export const McpServer = Schema.Struct({
  /** The key the harness knows this server by, e.g. "linear". */
  name: Schema.String,
  /** Which harness's config this came from. */
  cli: CliKind,
  transport: McpTransport,
  scope: McpScope,
  /**
   * Display-only summary of where the server lives: the command for `stdio`
   * (argv joined), or the URL for a remote one. Never contains env or headers.
   */
  target: Schema.String,
  /** Names of env vars the server is given. Values are deliberately absent. */
  envKeys: Schema.Array(Schema.String),
  /** Names of HTTP headers sent to a remote server. Values are deliberately absent. */
  headerKeys: Schema.Array(Schema.String),
  /** False when the harness's config explicitly disables/does not approve it. */
  enabled: Schema.Boolean
})
export type McpServer = Schema.Schema.Type<typeof McpServer>

/** The outcome of a live probe against one server. */
export const McpServerStatus = Schema.Struct({
  /** Matches `McpServer.name`. */
  name: Schema.String,
  scope: McpScope,
  state: McpServerState,
  /** Tools reported by `tools/list`; null unless the probe connected. */
  toolCount: Schema.NullOr(Schema.Number),
  /** Why the probe failed, for the dialog. Null when it didn't. */
  error: Schema.NullOr(Schema.String),
  /** ISO-8601 timestamp of the probe, so the dialog can show "checked 2m ago". */
  checkedAt: Schema.String
})
export type McpServerStatus = Schema.Schema.Type<typeof McpServerStatus>

/** Stable identity for a server across list/status/cache — name alone can collide across scopes. */
export const mcpServerKey = (scope: McpScope, name: string): string => `${scope}:${name}`
