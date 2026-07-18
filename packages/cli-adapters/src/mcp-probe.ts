import type { McpServerStatus } from "@starbase/core"
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
 * This spawns the servers' own commands. That is not a new trust boundary — they
 * are the exact commands the harness spawns on every run — but it does mean probes
 * are user-initiated only (opening the dialog, clicking refresh), never automatic
 * at startup.
 */

/** Long enough for a cold `npx` fetch, short enough that a hung server doesn't wedge the UI. */
export const PROBE_TIMEOUT = Duration.seconds(5)

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
 * Probe one server. Never fails — a probe that cannot connect is a `failed` status,
 * not an error, because "this server is broken" is exactly what we want to display.
 */
export const probeServer = (
  entry: ParsedMcpServer,
  cwd: string | null,
  now: () => string
): Effect.Effect<McpServerStatus> => {
  const base = { name: entry.server.name, scope: entry.server.scope }

  // A server the harness won't load is reported as such rather than probed — starting
  // it would report `connected` for something the agent never actually gets.
  if (!entry.server.enabled) {
    return Effect.succeed({ ...base, state: "disabled" as const, toolCount: null, error: null, checkedAt: now() })
  }

  return Effect.tryPromise({
    try: (signal) => connectAndCount(entry.launch, cwd, signal),
    catch: (cause) => message(cause)
  }).pipe(
    Effect.timeoutFail({
      duration: PROBE_TIMEOUT,
      onTimeout: () => `timed out after ${Duration.toMillis(PROBE_TIMEOUT)}ms`
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
  now: () => string
): Effect.Effect<ReadonlyArray<McpServerStatus>> =>
  Effect.forEach(entries, (entry) => probeServer(entry, cwd, now), { concurrency: PROBE_CONCURRENCY })
