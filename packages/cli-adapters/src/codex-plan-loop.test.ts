import type { Plan, QuestionRequest, StreamEvent } from "@starbase/core"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentContext, PlanDecision as PlanDecisionType, SessionSpec } from "./adapter.js"
import { PlanDecision } from "./adapter.js"

/**
 * The Codex plan loop, which is the one part of `runCodex` that cannot be
 * covered by the pure ThreadEvent→StreamEvent seam: it spans several harness
 * turns, and its whole job is to react to the operator between them.
 *
 * Codex has no `ExitPlanMode` and no `canUseTool`, so BOTH halves of plan mode
 * happen through the prompt — the plan arrives as a fenced block in an ordinary
 * reply, and the operator's verdict goes back as the next turn's prompt. That
 * makes "what was prompted, in what order, against which sandbox" the entire
 * contract, and none of it is observable from a pure function.
 *
 * The SDK is mocked rather than run because a live Codex turn needs a real
 * ChatGPT login. It is kept in its own file so `codex-adapter.test.ts` stays
 * what it says it is: the pure seam.
 */

// ── The scripted SDK double ──────────────────────────────────────────────────

interface RecordedRun {
  readonly prompt: string
  readonly sandboxMode: string
}

const sdk = vi.hoisted(() => {
  const state = {
    /** Turns to serve, in order: each is the events one `runStreamed` yields. */
    script: [] as Array<ReadonlyArray<unknown>>,
    runs: [] as RecordedRun[],
    /** The policy the CURRENT thread handle was opened with. */
    sandboxMode: "",
    resumedWith: [] as string[]
  }

  const makeThread = (options: { sandboxMode?: string }) => {
    state.sandboxMode = options.sandboxMode ?? ""
    return {
      runStreamed: (prompt: string) => {
        state.runs.push({ prompt, sandboxMode: state.sandboxMode })
        const events = state.script.shift() ?? []
        return Promise.resolve({
          events: (async function* () {
            for (const e of events) yield e
          })()
        })
      }
    }
  }

  class Codex {
    startThread(options: { sandboxMode?: string }) {
      return makeThread(options)
    }
    resumeThread(id: string, options: { sandboxMode?: string }) {
      state.resumedWith.push(id)
      return makeThread(options)
    }
  }

  return { state, Codex }
})

const contextProbe = vi.hoisted(() => ({
  calls: [] as Array<{ binPath: string | null | undefined; threadId: string; signal: AbortSignal | undefined }>
}))

vi.mock("@openai/codex-sdk", () => ({ Codex: sdk.Codex }))
vi.mock("./codex-app-server.js", () => ({
  readCodexContextUsage: (
    binPath: string | null | undefined,
    threadId: string,
    signal?: AbortSignal
  ) => {
    contextProbe.calls.push({ binPath, threadId, signal })
    return Promise.resolve({ tokens: 193_496, window: 258_400 })
  }
}))

// Imported AFTER the mock is registered.
const { runCodexSdk: runCodex } = await import("./codex-adapter.js")

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLAN_TEXT = [
  "Here is what I propose.",
  "",
  "```plan",
  "summary: Add a tier column",
  "01 Add the column",
  "  intent: Accounts need a billing tier.",
  "  approach: write the migration",
  "  files: A migrations/003.sql +12",
  "02 Backfill it",
  "  intent: Existing rows need a value.",
  "  approach: batch update",
  "  depends: 01",
  "```"
].join("\n")

const QUESTION_TEXT = [
  "```question",
  JSON.stringify({
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "Postgres", description: "Use the existing service." },
          { label: "SQLite", description: "Add a local store." }
        ]
      }
    ]
  }),
  "```"
].join("\n")

const agentMessage = (text: string) => ({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text }
})

const turnDone = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }

const spec = (over: Partial<SessionSpec> = {}): SessionSpec =>
  ({
    cli: "codex",
    repo: "r",
    branch: "b",
    cwd: process.cwd(),
    prompt: "plan the tier column",
    images: [],
    binPath: "/usr/bin/codex",
    mode: "plan",
    model: null,
    ...over
  }) as SessionSpec

const harness = (decisions: ReadonlyArray<PlanDecisionType>) => {
  const emitted: StreamEvent[] = []
  const proposed: Plan[] = []
  const questions: string[] = []
  let n = 0
  const ctx: AgentContext = {
    emit: (event: StreamEvent) => Effect.sync(() => void emitted.push(event)),
    canUseTool: () => Effect.succeed({ behavior: "allow" as const }),
    askQuestion: (request: QuestionRequest) =>
      Effect.sync(() => {
        questions.push(request.id)
        return [{ selected: ["Postgres"], other: null }]
      }),
    proposePlan: (plan: Plan) =>
      Effect.sync(() => {
        proposed.push(plan)
        return decisions[n++] ?? PlanDecision.Reject()
      }),
    registerBackgroundStop: () => Effect.void
  } as unknown as AgentContext
  return { ctx, emitted, proposed, questions }
}

beforeEach(() => {
  sdk.state.script = []
  sdk.state.runs = []
  sdk.state.resumedWith = []
  sdk.state.sandboxMode = ""
  contextProbe.calls = []
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe("the Codex plan loop", () => {
  it("plans read-only, then executes with write access once approved", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage("Done — migration written."), turnDone]
    ]
    const { ctx, proposed, emitted } = harness([PlanDecision.Approve({ mode: "accept-edits" })])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(proposed.map((p) => p.summary)).toEqual(["Add a tier column"])
    expect(proposed[0]!.steps.map((s) => s.number)).toEqual(["01", "02"])
    // The point of the whole change: planning cannot write, execution can.
    expect(sdk.state.runs.map((r) => r.sandboxMode)).toEqual(["read-only", "workspace-write"])
    // Same thread id, so the agent does not re-derive what it just worked out.
    expect(sdk.state.resumedWith).toEqual(["t1"])
    // The approved plan is restated, because a re-opened thread is a new turn.
    expect(sdk.state.runs[1]!.prompt).toContain("Add a tier column")
    expect(emitted.some((e) => e._tag === "Done")).toBe(true)
    // The planning reply queued an execution follow-up. Replaying the whole
    // thread between them would add probe latency to an unfinished turn.
    expect(contextProbe.calls).toHaveLength(1)
    expect(contextProbe.calls[0]).toMatchObject({
      binPath: "/usr/bin/codex",
      threadId: "t1"
    })
    expect(contextProbe.calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it("sends the operator's comments back as the next prompt on revise", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage("Done."), turnDone]
    ]
    const { ctx, proposed } = harness([
      PlanDecision.Revise({ feedback: "step 02 backfills a column step 01 creates" }),
      PlanDecision.Approve({ mode: "auto" })
    ])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(sdk.state.runs[1]!.prompt).toContain("backfills a column step 01 creates")
    // Revision stays read-only — only approval widens the sandbox.
    expect(sdk.state.runs.map((r) => r.sandboxMode)).toEqual([
      "read-only",
      "read-only",
      "danger-full-access"
    ])
    expect(proposed).toHaveLength(2)
    // Distinct ids, so the second proposal renders as a revision rather than
    // silently overwriting the first.
    expect(proposed[0]!.id).not.toBe(proposed[1]!.id)
    // Two intermediate plan rounds, one final execution round, one probe.
    expect(contextProbe.calls).toHaveLength(1)
  })

  it("ends the turn on reject without re-prompting", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone]
    ]
    const { ctx } = harness([PlanDecision.Reject()])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(sdk.state.runs).toHaveLength(1)
    expect(sdk.state.resumedWith).toEqual([])
  })

  it("does not swallow the plan block as prose", async () => {
    // The Plan card renders the whole message, fence and markdown alike. Emitting
    // it as Assistant text too would show the operator the same plan twice, once
    // reviewable and once not.
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage("Done."), turnDone]
    ]
    const { ctx, emitted, proposed } = harness([PlanDecision.Approve({ mode: "ask" })])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    const assistant = emitted.filter((e) => e._tag === "Assistant")
    expect(assistant.some((e) => "text" in e && e.text.includes("```plan"))).toBe(false)
    // …and the plan itself kept the prose that surrounded the block.
    expect(proposed[0]!.raw).toContain("Here is what I propose.")
  })

  it("ignores a plan block outside plan mode", async () => {
    // An agent quoting a plan during ordinary work is not proposing one. Without
    // the mode guard, pasting a plan into a normal turn would park the run on an
    // approval the operator never asked for.
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone]
    ]
    const { ctx, proposed, emitted } = harness([])

    await Effect.runPromise(runCodex("s1", spec({ mode: "accept-edits" }), ctx, new Map()))

    expect(proposed).toEqual([])
    expect(emitted.some((e) => e._tag === "Assistant")).toBe(true)
  })

  it("does not probe context for a one-shot fresh thread", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage("Reviewed."), turnDone]
    ]
    const { ctx } = harness([])

    await Effect.runPromise(
      runCodex("review_1", spec({ mode: "ask", fresh: true, readOnly: true }), ctx, new Map())
    )

    expect(contextProbe.calls).toEqual([])
  })

  it("degrades to plain text once the round cap is spent", async () => {
    // Six revisions is an operator reviewing; a seventh is a model that cannot
    // converge. Past the cap the block stays in the reply — no card, no error,
    // exactly what happened before this channel existed.
    const revise = PlanDecision.Revise({ feedback: "again" })
    sdk.state.script = Array.from({ length: 8 }, (_, i) =>
      i === 0
        ? [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone]
        : [agentMessage(PLAN_TEXT), turnDone]
    )
    const { ctx, proposed, emitted } = harness(Array.from({ length: 8 }, () => revise))

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(proposed).toHaveLength(6)
    expect(emitted.some((e) => e._tag === "Assistant" && "text" in e && e.text.includes("```plan"))).toBe(true)
  })

  it("keeps the question budget independent from plan revisions", async () => {
    const revise = PlanDecision.Revise({ feedback: "revise again" })
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(QUESTION_TEXT), turnDone],
      [agentMessage("Done."), turnDone]
    ]
    const { ctx, questions } = harness([revise, revise, revise, revise])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(questions).toStrictEqual(["q_s1_0"])
    expect(sdk.state.runs[5]!.prompt).toContain("Database: Postgres")
  })
})
