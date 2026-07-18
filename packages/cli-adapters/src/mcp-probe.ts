import type { CliKind, McpServerStatus } from "@starbase/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Duration, Effect } from "effect"
import type { McpLaunch, ParsedMcpServer } from "./mcp-config.js"

/**
 * Live probing: does a configured MCP server actually answer?
 *
 * Reading config only tells us a server is *configured*. This runs the real MCP
 * handshake (`initialize`, then `tools/list`) via the official SDK client, so the
 * UI can say "connected, 6 tools" rather than merely "present in a file".
 *
 * TRUST: this spawns the servers' own commands, so probing is user-initiated only
 * (opening the dialog, clicking refresh) and never automatic at startup. For most
 * servers it is not a new trust boundary — they are the exact commands the harness
 * runs anyway. The exception is a project-scope server from a harness that gates
 * project config behind its own consent prompt, where probing would execute what a
 * cloned repo committed *before* the harness ever asked. Those are not probed; see
 * `probeableScope`.
 */

/**
 * A cold `npx -y <pkg>` has to hit the registry and install before it says anything,
 * which routinely runs past 10s — and most real configs are exactly that shape. Too
 * short a timeout reports "failed" for a healthy server and then CACHES that answer,
 * so the bias is deliberately towards waiting. Still bounded, so one hung server
 * can't wedge the dialog.
 */
export const PROBE_TIMEOUT = Duration.seconds(15)

/** Bounded so a config with twenty servers doesn't fork twenty processes at once. */
export const PROBE_CONCURRENCY = 4

/** Error text is shown in the UI; cap it so a server dumping a stack can't flood the dialog. */
const MAX_ERROR = 200

const clientInfo = { name: "starbase", version: "0.0.0" } as const

const makeTransport = (launch: McpLaunch, cwd: string | null) => {
  if (launch.transport === "stdio") {
    if (launch.command === undefined) throw new Error("stdio server has no command")
    return new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      /**
       * Merge over the SDK's default environment rather than replacing it: passing
       * `env` alone would drop PATH/HOME and make almost every server fail to spawn,
       * which would look like a broken server rather than a broken probe.
       */
      env: { ...getDefaultEnvironment(), ...launch.env },
      // Project servers may use relative paths, so probe from the session's worktree.
      ...(cwd === null ? {} : { cwd }),
      // The server's stderr is noise here; we report the handshake result, not its logs.
      stderr: "ignore"
    })
  }
  if (launch.url === undefined) throw new Error("remote server has no url")
  const url = new URL(launch.url)
  const requestInit = Object.keys(launch.headers).length > 0 ? { headers: { ...launch.headers } } : undefined
  return launch.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit })
}

/**
 * Connect, count tools, and always close.
 *
 * The `signal` is wired to Effect's interruption, so a timeout tears the transport
 * down instead of leaving an orphaned child process behind.
 */
const connectAndCount = async (launch: McpLaunch, cwd: string | null, signal: AbortSignal): Promise<number> => {
  const client = new Client(clientInfo, { capabilities: {} })
  const transport = makeTransport(launch, cwd)
  const abort = () => void client.close().catch(() => {})
  signal.addEventListener("abort", abort, { once: true })
  try {
    // `connect` performs the MCP `initialize` handshake.
    await client.connect(transport)
    const { tools } = await client.listTools()
    return tools.length
  } finally {
    signal.removeEventListener("abort", abort)
    await client.close().catch(() => {})
  }
}

const message = (cause: unknown): string => {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.length > MAX_ERROR ? `${raw.slice(0, MAX_ERROR)}…` : raw
}

/**
 * Which harnesses gate project-scope servers behind their own approval, and so have
 * already asked the operator before Starbase probes anything.
 *
 * Claude records `.mcp.json` approvals in config we read, so an approved project
 * server is one the operator has consented to. Cursor and opencode prompt at
 * runtime and keep the answer somewhere we can't see, so from here a project entry
 * is indistinguishable from one a freshly-cloned repo just committed. Codex has no
 * project-scope MCP config at all, so the question never arises.
 */
const GATES_PROJECT_SERVERS: Record<CliKind, boolean> = {
  claude: true,
  codex: true,
  cursor: false,
  opencode: false
}

/**
 * Whether we may spawn this server at all.
 *
 * Probing an un-gated project-scope server would run whatever a cloned repo put in
 * `.cursor/mcp.json` — ahead of, and without, the harness's own consent prompt.
 * That IS a new trust boundary, so those report `unknown` (configured, deliberately
 * not contacted) rather than being executed to find out.
 */
export const probeableScope = (entry: ParsedMcpServer): boolean =>
  entry.server.scope !== "project" || GATES_PROJECT_SERVERS[entry.server.cli]

/**
 * Probe one server. Never fails — a probe that cannot connect is a `failed` status,
 * not an error, because "this server is broken" is exactly what we want to display.
 */
export const probeServer = (
  entry: ParsedMcpServer,
  cwd: string | null,
  now: () => string,
  /** Overridable so tests can exercise the timeout without a 15s wall-clock wait. */
  timeout: Duration.Duration = PROBE_TIMEOUT
): Effect.Effect<McpServerStatus> => {
  const base = { name: entry.server.name, scope: entry.server.scope }

  // A server the harness won't load is reported as such rather than probed — starting
  // it would report `connected` for something the agent never actually gets.
  if (!entry.server.enabled) {
    return Effect.succeed({ ...base, state: "disabled" as const, toolCount: null, error: null, checkedAt: now() })
  }

  // Un-gated project-scope server: listed, never executed. See `probeableScope`.
  if (!probeableScope(entry)) {
    return Effect.succeed({ ...base, state: "unknown" as const, toolCount: null, error: null, checkedAt: now() })
  }

  return Effect.tryPromise({
    try: (signal) => connectAndCount(entry.launch, cwd, signal),
    catch: (cause) => message(cause)
  }).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => `timed out after ${Duration.toMillis(timeout)}ms`
    }),
    Effect.map((toolCount) => ({
      ...base,
      state: "connected" as const,
      toolCount,
      error: null,
      checkedAt: now()
    })),
    Effect.catchAll((error) =>
      Effect.succeed({ ...base, state: "failed" as const, toolCount: null, error, checkedAt: now() })
    )
  )
}

/** Probe many servers concurrently, bounded. Order matches the input. */
export const probeAll = (
  entries: ReadonlyArray<ParsedMcpServer>,
  cwd: string | null,
  now: () => string,
  timeout: Duration.Duration = PROBE_TIMEOUT
): Effect.Effect<ReadonlyArray<McpServerStatus>> =>
  Effect.forEach(entries, (entry) => probeServer(entry, cwd, now, timeout), {
    concurrency: PROBE_CONCURRENCY
  })
