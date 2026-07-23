import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { CodexAppServerConnection } from "./codex-app-server-client.js"

const harness = () => {
  const clientInput = new PassThrough()
  const clientOutput = new PassThrough()
  const sent: Array<Record<string, unknown>> = []
  let buffer = ""
  clientInput.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          sent.push(Object.fromEntries(Object.entries(parsed)))
        }
      }
    }
  })
  const connection = new CodexAppServerConnection(
    clientInput,
    clientOutput,
    () => {
      clientInput.end()
      clientOutput.end()
    }
  )
  return { connection, output: clientOutput, sent }
}

describe("CodexAppServerConnection", () => {
  it("correlates responses without leaking them into the notification queue", async () => {
    const { connection, output, sent } = harness()
    const request = connection.request("thread/start", { cwd: "/repo" })
    expect(sent[0]).toMatchObject({ id: 1, method: "thread/start" })

    output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { thread: { id: "t1" } } })}\n`)
    await expect(request).resolves.toStrictEqual({ thread: { id: "t1" } })

    output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1" } })}\n`)
    await expect(connection.nextMessage()).resolves.toMatchObject({ method: "turn/started" })
    connection.close()
  })

  it("preserves notification and server-request ordering", async () => {
    const { connection, output } = harness()
    output.write(
      [
        JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "t1" } }),
        JSON.stringify({ jsonrpc: "2.0", id: "approval-1", method: "item/fileChange/requestApproval", params: {} })
      ].join("\n") + "\n"
    )

    await expect(connection.nextMessage()).resolves.toMatchObject({
      method: "thread/tokenUsage/updated"
    })
    await expect(connection.nextMessage()).resolves.toMatchObject({
      id: "approval-1",
      method: "item/fileChange/requestApproval"
    })
    connection.close()
  })

  it("drains replay notifications without blocking for a future message", () => {
    const { connection, output } = harness()
    output.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "t1" } })}\n`
    )
    expect(connection.drainMessages()).toStrictEqual([
      {
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "t1" }
      }
    ])
    expect(connection.drainMessages()).toStrictEqual([])
    connection.close()
  })

  it("rejects a pending request when the transport closes", async () => {
    const { connection, output } = harness()
    const request = connection.request("turn/start", {})
    output.end()
    await expect(request).rejects.toThrow("Codex app-server closed")
  })
})
