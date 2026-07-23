import { describe, expect, it } from "vitest"
import { codexContextUsageFromMessage } from "./codex-app-server.js"

describe("codexContextUsageFromMessage", () => {
  it("reads resident context rather than cumulative spend", () => {
    expect(
      codexContextUsageFromMessage(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "019f8e18-e349-70f3-95ce-ca343fb3d016",
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
        },
        "019f8e18-e349-70f3-95ce-ca343fb3d016"
      )
    ).toStrictEqual({ tokens: 193_496, window: 258_400 })
  })

  it("ignores usage for a different thread", () => {
    expect(
      codexContextUsageFromMessage(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "other",
            tokenUsage: {
              last: { totalTokens: 12_000 },
              modelContextWindow: 258_400
            }
          }
        },
        "wanted"
      )
    ).toBeNull()
  })

  it.each([
    null,
    {},
    { method: "turn/completed", params: {} },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "wanted",
        tokenUsage: { last: { totalTokens: Number.NaN }, modelContextWindow: 258_400 }
      }
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "wanted",
        tokenUsage: { last: { totalTokens: 1_000 }, modelContextWindow: 0 }
      }
    }
  ])("degrades malformed notifications to null", (message) => {
    expect(codexContextUsageFromMessage(message, "wanted")).toBeNull()
  })
})
