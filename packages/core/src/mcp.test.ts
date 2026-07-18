import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { McpScope, McpServer, McpServerState, McpServerStatus, McpTransport, mcpServerKey } from "./mcp.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input)

const SERVER = {
  name: "linear",
  cli: "claude",
  transport: "stdio",
  scope: "user",
  target: "npx -y @linear/mcp",
  envKeys: ["LINEAR_API_KEY"],
  headerKeys: [],
  enabled: true
} as const

describe("McpTransport / McpScope / McpServerState", () => {
  it("accepts every documented member", () => {
    for (const t of ["stdio", "http", "sse"]) expect(Either.isRight(decode(McpTransport, t))).toBe(true)
    for (const s of ["user", "project", "local"]) expect(Either.isRight(decode(McpScope, s))).toBe(true)
    for (const s of ["unknown", "connected", "failed", "disabled"])
      expect(Either.isRight(decode(McpServerState, s))).toBe(true)
  })

  it("rejects an unknown transport, scope or state", () => {
    expect(Either.isLeft(decode(McpTransport, "websocket"))).toBe(true)
    expect(Either.isLeft(decode(McpScope, "global"))).toBe(true)
    expect(Either.isLeft(decode(McpServerState, "degraded"))).toBe(true)
  })
})

describe("McpServer", () => {
  it("decodes a well-formed server", () => {
    expect(Either.isRight(decode(McpServer, SERVER))).toBe(true)
  })

  it("rejects a cli that isn't a CliKind", () => {
    expect(Either.isLeft(decode(McpServer, { ...SERVER, cli: "aider" }))).toBe(true)
  })

  it("requires every field — a config-shaped object alone is not an McpServer", () => {
    expect(Either.isLeft(decode(McpServer, { name: "linear", command: "npx" }))).toBe(true)
  })

  /**
   * The redaction contract. `envKeys`/`headerKeys` are arrays of NAMES; there is
   * deliberately no field that can carry a value. If someone adds one, this test
   * is the tripwire — it asserts on the schema's own field list, not on data.
   */
  it("has no field capable of holding a secret value", () => {
    const fields = Object.keys(McpServer.fields)
    expect(fields).toStrictEqual([
      "name",
      "cli",
      "transport",
      "scope",
      "target",
      "envKeys",
      "headerKeys",
      "enabled"
    ])
    expect(fields).not.toContain("env")
    expect(fields).not.toContain("headers")
    expect(fields).not.toContain("httpHeaders")
  })

  it("carries env var names only, so a value cannot survive a round-trip", () => {
    const decoded = decode(McpServer, { ...SERVER, envKeys: ["LINEAR_API_KEY"] })
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded)) {
      expect(JSON.stringify(decoded.right)).not.toContain("secret")
      expect(decoded.right.envKeys).toStrictEqual(["LINEAR_API_KEY"])
    }
  })
})

describe("McpServerStatus", () => {
  it("decodes a connected probe", () => {
    const status = {
      name: "linear",
      scope: "user",
      state: "connected",
      toolCount: 6,
      error: null,
      checkedAt: "2026-07-18T00:00:00.000Z"
    }
    expect(Either.isRight(decode(McpServerStatus, status))).toBe(true)
  })

  it("decodes a failed probe carrying an error and no tool count", () => {
    const status = {
      name: "broken",
      scope: "project",
      state: "failed",
      toolCount: null,
      error: "timed out after 5000ms",
      checkedAt: "2026-07-18T00:00:00.000Z"
    }
    expect(Either.isRight(decode(McpServerStatus, status))).toBe(true)
  })

  it("rejects an absent toolCount — null is the explicit 'did not connect' signal", () => {
    const status = { name: "x", scope: "user", state: "failed", error: null, checkedAt: "2026-07-18T00:00:00.000Z" }
    expect(Either.isLeft(decode(McpServerStatus, status))).toBe(true)
  })
})

describe("mcpServerKey", () => {
  it("distinguishes same-named servers in different scopes", () => {
    expect(mcpServerKey("user", "linear")).not.toBe(mcpServerKey("project", "linear"))
  })

  it("is stable for the same scope and name", () => {
    expect(mcpServerKey("local", "linear")).toBe(mcpServerKey("local", "linear"))
  })
})
