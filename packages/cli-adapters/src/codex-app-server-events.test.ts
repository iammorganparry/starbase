import { describe, expect, it } from "vitest"
import {
  codexAppServerMessageToStreamEvents,
  completedAgentReply,
  completedTurn,
  makeCodexAppServerEventState
} from "./codex-app-server-events.js"

describe("codex app-server event mapping", () => {
  it("emits authoritative live resident-context usage", () => {
    expect(
      codexAppServerMessageToStreamEvents(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "t1",
            turnId: "turn-1",
            tokenUsage: {
              total: { totalTokens: 900_000 },
              last: { totalTokens: 193_496 },
              modelContextWindow: 258_400
            }
          }
        },
        "t1",
        makeCodexAppServerEventState()
      )
    ).toStrictEqual([{ _tag: "Usage", tokens: 193_496, window: 258_400 }])
  })

  it("streams command output as cumulative snapshots and settles the card", () => {
    const state = makeCodexAppServerEventState()
    const start = codexAppServerMessageToStreamEvents(
      {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: "c1",
            command: "pnpm test",
            status: "inProgress"
          }
        }
      },
      "t1",
      state
    )
    const first = codexAppServerMessageToStreamEvents(
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "c1", delta: "RUN\n" }
      },
      "t1",
      state
    )
    const second = codexAppServerMessageToStreamEvents(
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "c1", delta: "PASS\n" }
      },
      "t1",
      state
    )
    const end = codexAppServerMessageToStreamEvents(
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            id: "c1",
            command: "pnpm test",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "RUN\nPASS\n"
          }
        }
      },
      "t1",
      state
    )

    expect(start).toStrictEqual([
      { _tag: "ToolStart", id: "c1", name: "Bash", target: "pnpm test" }
    ])
    expect(first).toStrictEqual([{ _tag: "ToolDelta", id: "c1", output: "RUN\n" }])
    expect(second).toStrictEqual([{ _tag: "ToolDelta", id: "c1", output: "RUN\nPASS\n" }])
    expect(end).toStrictEqual([
      {
        _tag: "ToolEnd",
        id: "c1",
        status: "success",
        meta: "exit 0",
        diff: null,
        preview: null,
        output: "RUN\nPASS\n"
      }
    ])
  })

  it("holds agent deltas and emits the completed text for interception", () => {
    const state = makeCodexAppServerEventState()
    const delta = codexAppServerMessageToStreamEvents(
      {
        method: "item/agentMessage/delta",
        params: { itemId: "m1", delta: "hello" }
      },
      "t1",
      state
    )
    const completed = {
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "m1", text: "hello" } }
    }
    expect(delta).toStrictEqual([])
    expect(codexAppServerMessageToStreamEvents(completed, "t1", state)).toStrictEqual([
      { _tag: "Assistant", text: "hello" }
    ])
    expect(completedAgentReply(completed)).toBe("hello")
  })

  it("decodes a failed terminal turn", () => {
    expect(
      completedTurn(
        {
          method: "turn/completed",
          params: {
            threadId: "t1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "context exhausted" }
            }
          }
        },
        "t1"
      )
    ).toStrictEqual({
      turnId: "turn-1",
      status: "failed",
      error: "context exhausted"
    })
  })

  it("does not fail the Starbase turn for an error Codex will retry", () => {
    expect(
      codexAppServerMessageToStreamEvents(
        {
          method: "error",
          params: {
            willRetry: true,
            error: { message: "temporary connection loss" }
          }
        },
        "t1",
        makeCodexAppServerEventState()
      )
    ).toStrictEqual([])
  })
})
