import { describe, expect, it } from "vitest"
import { codexContextUsageFromMessage } from "./codex-app-server.js"

const THREAD_ID = "019f7427-cd67-7d12-9d4f-15ea8dbb3cf3"

const productionUsage = {
  jsonrpc: "2.0",
  method: "thread/tokenUsage/updated",
  params: {
    threadId: THREAD_ID,
    turnId: "turn_royal_liskov",
    tokenUsage: {
      total: {
        inputTokens: 2_961_789,
        cachedInputTokens: 2_758_656,
        outputTokens: 17_495,
        reasoningOutputTokens: 10_295,
        totalTokens: 2_979_284
      },
      last: {
        inputTokens: 190_098,
        cachedInputTokens: 186_112,
        outputTokens: 3_398,
        reasoningOutputTokens: 1_174,
        totalTokens: 193_496
      },
      modelContextWindow: 258_400
    }
  }
}

describe("codexContextUsageFromMessage", () => {
  it("reads resident usage instead of cumulative spend", () => {
    expect(codexContextUsageFromMessage(productionUsage, THREAD_ID)).toStrictEqual({
      tokens: 193_496,
      window: 258_400
    })
  })

  it("ignores usage for a different thread", () => {
    expect(codexContextUsageFromMessage(productionUsage, "another-thread")).toBeNull()
  })

  it.each([
    null,
    {},
    { ...productionUsage, method: "turn/completed" },
    {
      ...productionUsage,
      params: {
        ...productionUsage.params,
        tokenUsage: {
          ...productionUsage.params.tokenUsage,
          last: { ...productionUsage.params.tokenUsage.last, totalTokens: Number.NaN }
        }
      }
    },
    {
      ...productionUsage,
      params: {
        ...productionUsage.params,
        tokenUsage: { ...productionUsage.params.tokenUsage, modelContextWindow: 0 }
      }
    }
  ])("degrades malformed or unrelated messages to null", (message) => {
    expect(codexContextUsageFromMessage(message, THREAD_ID)).toBeNull()
  })
})
