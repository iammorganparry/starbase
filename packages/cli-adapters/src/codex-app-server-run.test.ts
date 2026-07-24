import type { Plan, QuestionRequest, StreamEvent } from "@starbase/core"
import { Effect, Fiber } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AgentContext,
  PlanDecision as PlanDecisionType,
  SessionSpec
} from "./adapter.js"
import { PlanDecision } from "./adapter.js"

const server = vi.hoisted(() => {
  const state = {
    messages: [] as Array<Record<string, unknown>>,
    replay: [] as Array<Record<string, unknown>>,
    delayedReplay: [] as Array<Record<string, unknown>>,
    requests: [] as Array<{
      method: string
      params: unknown
      options?: { timeoutMs?: number }
    }>,
    responses: [] as Array<{ id: number | string; result: unknown }>,
    threadId: "thread-1",
    resumeError: null as Error | null,
    turnNumber: 0,
    hangMessages: false,
    closed: false
  }
  const connection = {
    request: (
      method: string,
      params: unknown,
      options?: { timeoutMs?: number }
    ) => {
      state.requests.push({ method, params, ...(options ? { options } : {}) })
      if (method === "thread/resume" && state.resumeError !== null) {
        const error = state.resumeError
        state.resumeError = null
        return Promise.reject(error)
      }
      if (method === "thread/start" || method === "thread/resume") {
        return Promise.resolve({ thread: { id: state.threadId } })
      }
      if (method === "turn/start") {
        state.turnNumber += 1
        return Promise.resolve({ turn: { id: `turn-${state.turnNumber}` } })
      }
      return Promise.resolve({})
    },
    notify: vi.fn(),
    respond: (id: number | string, result: unknown) => {
      state.responses.push({ id, result })
    },
    respondError: vi.fn(),
    nextMessage: () =>
      state.hangMessages
        ? new Promise<null>(() => undefined)
        : Promise.resolve(state.messages.shift() ?? null),
    nextMessageWithin: () =>
      Promise.resolve(state.delayedReplay.shift() ?? null),
    drainMessages: () => state.replay.splice(0),
    close: () => {
      state.closed = true
    }
  }
  return { state, connection }
})

vi.mock("./codex-app-server-client.js", () => ({
  startCodexAppServer: () => Promise.resolve(server.connection)
}))

const { mapCodexAppServerReasoning, runCodexAppServer } = await import(
  "./codex-app-server-run.js"
)

const spec = (over: Partial<SessionSpec> = {}): SessionSpec =>
  ({
    cli: "codex",
    repo: "r",
    branch: "b",
    cwd: process.cwd(),
    prompt: "inspect the repository",
    images: [],
    binPath: "/usr/bin/codex",
    mode: "accept-edits",
    model: "gpt-5.6-sol",
    resumeId: null,
    ...over
  }) as SessionSpec

const harness = (decision: PlanDecisionType = PlanDecision.Reject()) => {
  const emitted: StreamEvent[] = []
  const proposed: Plan[] = []
  const asked: QuestionRequest[] = []
  const ctx: AgentContext = {
    emit: (event) => Effect.sync(() => void emitted.push(event)),
    canUseTool: () => Effect.succeed("allow"),
    askQuestion: (request) =>
      Effect.sync(() => {
        asked.push(request)
        return [{ selected: ["Postgres"], other: null }]
      }),
    proposePlan: (plan) =>
      Effect.sync(() => {
        proposed.push(plan)
        return decision
      }),
    registerBackgroundStop: () => Effect.void
  }
  return { ctx, emitted, proposed, asked }
}

beforeEach(() => {
  server.state.messages = []
  server.state.replay = []
  server.state.delayedReplay = []
  server.state.requests = []
  server.state.responses = []
  server.state.threadId = "thread-1"
  server.state.resumeError = null
  server.state.turnNumber = 0
  server.state.hangMessages = false
  server.state.closed = false
})

describe("runCodexAppServer", () => {
  it("replaces a persisted thread whose local rollout no longer exists", async () => {
    server.state.threadId = "replacement-thread"
    server.state.resumeError = new Error(
      "thread/resume failed: no rollout found for thread id stale-thread (code -32600)"
    )
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "replacement-thread",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const resume = new Map<string, string>()
    const { ctx, emitted } = harness()

    await Effect.runPromise(
      runCodexAppServer(
        "s1",
        spec({ resumeId: "stale-thread" }),
        ctx,
        resume
      )
    )

    expect(server.state.requests.slice(0, 3).map((request) => request.method)).toStrictEqual([
      "thread/resume",
      "thread/start",
      "turn/start"
    ])
    expect(resume.get("s1")).toBe("replacement-thread")
    expect(emitted).toContainEqual({
      _tag: "Started",
      sessionId: "replacement-thread"
    })
  })

  it("does not replace a resumed thread after an unrelated error", async () => {
    server.state.resumeError = new Error("thread/resume failed: permission denied")
    const { ctx } = harness()

    await expect(
      Effect.runPromise(
        runCodexAppServer(
          "s1",
          spec({ resumeId: "thread-1" }),
          ctx,
          new Map()
        )
      )
    ).rejects.toThrow("permission denied")

    expect(server.state.requests.map((request) => request.method)).toStrictEqual([
      "thread/resume"
    ])
  })

  it("uses GPT-5.6's lightest supported effort for reasoning-off", () => {
    expect(mapCodexAppServerReasoning("off")).toBe("low")
    expect(mapCodexAppServerReasoning("think")).toBe("medium")
  })

  it("emits context while the turn is active, before its terminal event", async () => {
    server.state.messages = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 200_000 },
            last: { totalTokens: 120_000 },
            modelContextWindow: 258_400
          }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: "Done." }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(emitted.map((event) => event._tag)).toStrictEqual([
      "Started",
      "Usage",
      "Assistant",
      "Done"
    ])
    expect(emitted[1]).toStrictEqual({
      _tag: "Usage",
      tokens: 120_000,
      window: 258_400
    })
    expect(server.state.closed).toBe(true)
  })

  it("requests native compaction when an active turn reaches the emergency band", async () => {
    server.state.messages = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 240_000 },
            last: { totalTokens: 235_000 },
            modelContextWindow: 258_400
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(server.state.requests).toContainEqual({
      method: "thread/compact/start",
      params: { threadId: "thread-1" }
    })
  })

  it("requests emergency compaction only once when several high readings arrive", async () => {
    server.state.messages = [
      ...[235_000, 240_000, 245_000].map((tokens) => ({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: tokens },
            last: { totalTokens: tokens },
            modelContextWindow: 258_400
          }
        }
      })),
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(
      server.state.requests.filter((request) => request.method === "thread/compact/start")
    ).toHaveLength(1)
  })

  it("uses the runtime window rather than the model fallback for emergency compaction", async () => {
    server.state.messages = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 250_000 },
            last: { totalTokens: 250_000 },
            modelContextWindow: 400_000
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(
      server.state.requests.filter((request) => request.method === "thread/compact/start")
    ).toHaveLength(0)
    expect(emitted).toContainEqual({ _tag: "Usage", tokens: 250_000, window: 400_000 })
  })

  it("compacts an overloaded resumed thread before starting its next turn", async () => {
    server.state.replay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 900_000 },
            last: { totalTokens: 206_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(
      runCodexAppServer(
        "s1",
        spec({ resumeId: "thread-1" }),
        ctx,
        new Map()
      )
    )

    expect(server.state.requests.map((request) => request.method).slice(0, 3)).toStrictEqual([
      "thread/resume",
      "thread/compact/start",
      "turn/start"
    ])
    expect(emitted).toContainEqual({
      _tag: "Usage",
      tokens: 206_000,
      window: 258_400
    })
  })

  it("waits for delayed replay usage before starting a resumed turn", async () => {
    server.state.delayedReplay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 900_000 },
            last: { totalTokens: 206_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(
      runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map())
    )

    expect(server.state.requests.map((request) => request.method).slice(0, 3)).toStrictEqual([
      "thread/resume",
      "thread/compact/start",
      "turn/start"
    ])
  })

  it("ignores completion events from another turn on the active thread", async () => {
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "compaction-turn", status: "completed", error: null }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: "Active turn finished." }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(emitted).toContainEqual({ _tag: "Assistant", text: "Active turn finished." })
    expect(emitted.filter((event) => event._tag === "Done")).toHaveLength(1)
  })

  it("bounds the interrupt request before closing a wedged server", async () => {
    server.state.hangMessages = true
    const { ctx } = harness()
    const fiber = Effect.runFork(
      runCodexAppServer("s1", spec(), ctx, new Map())
    )
    await vi.waitFor(() => {
      expect(
        server.state.requests.some((request) => request.method === "turn/start")
      ).toBe(true)
    })

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(server.state.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
      options: { timeoutMs: 2_000 }
    })
    expect(server.state.closed).toBe(true)
  })

  it("fails instead of waiting forever when an active turn stops emitting events", async () => {
    vi.useFakeTimers()
    try {
      server.state.hangMessages = true
      const { ctx } = harness()
      const run = expect(
        Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))
      ).rejects.toThrow("Codex turn produced no events")

      await vi.waitFor(() => {
        expect(
          server.state.requests.some((request) => request.method === "turn/start")
        ).toBe(true)
      })
      await vi.runAllTimersAsync()

      await run
      expect(server.state.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts a resumed thread directly when replay usage is below the safety band", async () => {
    server.state.replay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 180_000 },
            last: { totalTokens: 180_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(
      runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map())
    )

    expect(server.state.requests.map((request) => request.method).slice(0, 2)).toStrictEqual([
      "thread/resume",
      "turn/start"
    ])
  })

  it("answers a native request-user-input request without starting another turn", async () => {
    server.state.messages = [
      {
        id: "question-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "item-1",
          questions: [
            {
              id: "database",
              header: "Database",
              question: "Which database?",
              options: [
                { label: "Postgres", description: "Use the service." },
                { label: "SQLite", description: "Use a local file." }
              ]
            }
          ]
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, asked } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(asked).toHaveLength(1)
    expect(server.state.responses).toStrictEqual([
      {
        id: "question-1",
        result: { answers: { database: { answers: ["Postgres"] } } }
      }
    ])
    expect(server.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(1)
  })

  it("reopens an approved plan with write access and continues on the same thread", async () => {
    const plan = [
      "```plan",
      "summary: Add a column",
      "01 Add column",
      "  intent: Store the tier.",
      "  approach: add a migration",
      "  files: A migrations/003.sql +12",
      "```"
    ].join("\n")
    server.state.messages = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: plan }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { type: "agentMessage", id: "m2", text: "Implemented." }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-2", status: "completed", error: null }
        }
      }
    ]
    const { ctx, proposed, emitted } = harness(
      PlanDecision.Approve({ mode: "accept-edits" })
    )

    await Effect.runPromise(
      runCodexAppServer("s1", spec({ mode: "plan" }), ctx, new Map())
    )

    expect(proposed).toHaveLength(1)
    expect(
      server.state.requests.filter((request) => request.method === "thread/resume")
    ).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: "thread-1",
          sandbox: "workspace-write"
        })
      })
    )
    expect(server.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(2)
    expect(emitted.some((event) => event._tag === "Assistant")).toBe(true)
  })
})
