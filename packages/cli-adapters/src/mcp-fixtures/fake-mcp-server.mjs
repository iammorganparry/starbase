#!/usr/bin/env node
/**
 * A deterministic stdio MCP server for probe tests.
 *
 * Speaks just enough of the protocol over newline-delimited JSON-RPC to satisfy
 * `initialize` + `tools/list`, and can be told to misbehave so every `McpServerState`
 * is reachable without depending on a real server being installed.
 *
 * Behaviour is driven by argv[0]:
 *   ok [n]        — normal server exposing n tools (default 2)
 *   hang          — accepts input, never replies (exercises the probe timeout)
 *   crash         — exits non-zero immediately (exercises spawn/transport failure)
 *   protocol      — replies with a JSON-RPC error to initialize
 *   needs-env VAR — behaves as `ok` only if VAR is set, else errors; proves the probe
 *                   forwards configured credentials rather than the redacted half
 */

const [mode = "ok", arg] = process.argv.slice(2)

if (mode === "crash") process.exit(3)

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

const toolCount = mode === "ok" && arg !== undefined ? Number(arg) : 2

const tools = Array.from({ length: Number.isFinite(toolCount) ? toolCount : 2 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Fake tool ${i}`,
  inputSchema: { type: "object", properties: {} }
}))

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString()
  let index = buffer.indexOf("\n")
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length > 0) handle(JSON.parse(line))
    index = buffer.indexOf("\n")
  }
})

const handle = (msg) => {
  // Never respond — the probe should time out and tear us down.
  if (mode === "hang") return
  // Notifications (no id) get no reply, by protocol.
  if (msg.id === undefined) return

  if (msg.method === "initialize") {
    if (mode === "protocol") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "initialize refused" } })
      return
    }
    if (mode === "needs-env" && process.env[arg] === undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `missing ${arg}` } })
      return
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-server", version: "1.0.0" }
      }
    })
    return
  }

  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } })
    return
  }

  send({ jsonrpc: "2.0", id: msg.id, result: {} })
}
