import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ApprovalGate,
  ContentPart,
  Message,
  Skill,
  StreamEvent,
  addPlanComment,
  applyStreamEvent,
  assistantMessage,
  latestPlan,
  pendingPlan,
  pendingQuestion,
  setGateStatus,
  setPlanStatus,
  setPlanStepStatus,
  setQuestionAnswers,
  settleLoaded,
  settleStreaming,
  userMessage
} from "./conversation.js"
import type { Plan, PlanComment, QuestionRequest } from "./conversation.js"

/**
 * These schemas cross the RPC boundary and back persistence (transcripts.json),
 * and `applyStreamEvent` is the single fold reused by the runner (persist) and
 * the renderer (render). So the behaviours that matter are: valid data decodes,
 * invalid literals are rejected, encode→decode is identity, and folding a
 * sequence of events yields the transcript the operator should see. We assert
 * those outcomes, never the internal shape.
 */

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input)

describe("ContentPart", () => {
  it("decodes each tagged variant", () => {
    expect(Either.isRight(decode(ContentPart, { _tag: "Text", text: "hi" }))).toBe(true)
    expect(
      Either.isRight(
        decode(ContentPart, { _tag: "Thinking", text: "…", seconds: 6, streaming: false })
      )
    ).toBe(true)
    expect(
      Either.isRight(
        decode(ContentPart, {
          _tag: "Tool",
          tool: {
            id: "t1",
            name: "Edit",
            target: "src/a.ts",
            status: "success",
            meta: null,
            diff: { added: 7, removed: 0 },
            preview: "+ line"
          }
        })
      )
    ).toBe(true)
  })

  it("rejects an unknown part tag", () => {
    expect(Either.isLeft(decode(ContentPart, { _tag: "Image", url: "x" }))).toBe(true)
  })

  it("rejects an unknown tool status", () => {
    const result = decode(ContentPart, {
      _tag: "Tool",
      tool: { id: "t", name: "Bash", target: null, status: "exploded", meta: null, diff: null, preview: null }
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("ApprovalGate", () => {
  it("round-trips a command gate through encode → decode", () => {
    const gate: ApprovalGate = {
      id: "g1",
      kind: "command",
      title: "Approval needed · run a command",
      detail: "Not in your allowlist.",
      command: "npm test -- billing",
      allowLabel: "npm test",
      status: "pending"
    }
    expect(Schema.decodeUnknownSync(ApprovalGate)(Schema.encodeSync(ApprovalGate)(gate))).toStrictEqual(gate)
  })

  it("rejects an unknown gate status", () => {
    const result = decode(ApprovalGate, {
      id: "g",
      kind: "edit",
      title: "t",
      detail: "d",
      command: null,
      allowLabel: null,
      status: "maybe"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("Skill", () => {
  it("rejects an unknown source", () => {
    expect(Either.isLeft(decode(Skill, { name: "/plan", description: "x", source: "macro" }))).toBe(true)
  })
})

describe("Message round-trip", () => {
  it("encode → decode preserves an interleaved assistant turn", () => {
    const msg: Message = {
      id: "m2",
      role: "assistant",
      streaming: false,
      createdAt: "2026-07-11T10:00:00.000Z",
      parts: [
        { _tag: "Thinking", text: "planning", seconds: 6, streaming: false },
        {
          _tag: "Tool",
          tool: { id: "t1", name: "Read", target: "src/a.ts", status: "success", meta: "142 lines", diff: null, preview: null }
        },
        { _tag: "Text", text: "done" }
      ]
    }
    expect(Schema.decodeUnknownSync(Message)(Schema.encodeSync(Message)(msg))).toStrictEqual(msg)
  })
})

describe("StreamEvent", () => {
  it("decodes a ToolEnd with a diff", () => {
    const result = decode(StreamEvent, {
      _tag: "ToolEnd",
      id: "t1",
      status: "success",
      meta: null,
      diff: { added: 7, removed: 0 },
      preview: "+ added a line"
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("rejects an unknown event tag", () => {
    expect(Either.isLeft(decode(StreamEvent, { _tag: "Whoops" }))).toBe(true)
  })

  it("decodes a Started event with and without the optional model", () => {
    expect(Either.isRight(decode(StreamEvent, { _tag: "Started", sessionId: "s1" }))).toBe(true)
    expect(
      Either.isRight(decode(StreamEvent, { _tag: "Started", sessionId: "s1", model: "opus" }))
    ).toBe(true)
  })
})

describe("applyStreamEvent fold", () => {
  const fold = (events: ReadonlyArray<StreamEvent>): Message =>
    events.reduce(applyStreamEvent, assistantMessage("m1", "2026-07-11T10:00:00.000Z"))

  it("accumulates streamed thinking deltas into one finished block", () => {
    const msg = fold([
      { _tag: "Thinking", text: "No limiter ", seconds: null, done: false },
      { _tag: "Thinking", text: "exists yet.", seconds: 6, done: true }
    ])
    expect(msg.parts).toStrictEqual([
      { _tag: "Thinking", text: "No limiter exists yet.", seconds: 6, streaming: false }
    ])
  })

  it("accumulates assistant text deltas into one paragraph", () => {
    const msg = fold([
      { _tag: "Assistant", text: "Adding the " },
      { _tag: "Assistant", text: "middleware." }
    ])
    expect(msg.parts).toStrictEqual([{ _tag: "Text", text: "Adding the middleware." }])
  })

  it("patches a running tool to success on ToolEnd, preserving order", () => {
    const msg = fold([
      { _tag: "ToolStart", id: "t1", name: "Edit", target: "src/billing.ts" },
      { _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: { added: 7, removed: 0 }, preview: "+ router.post(...)" }
    ])
    expect(msg.parts).toHaveLength(1)
    const part = msg.parts.find((p) => p._tag === "Tool")
    expect(part).toBeDefined()
    if (part && part._tag === "Tool") {
      expect(part.tool.status).toBe("success")
      expect(part.tool.diff).toStrictEqual({ added: 7, removed: 0 })
      expect(part.tool.preview).toBe("+ router.post(...)")
    }
  })

  it("keeps interleaved order and clears streaming on Done", () => {
    const msg = fold([
      { _tag: "Started", sessionId: "s1" },
      { _tag: "Thinking", text: "plan", seconds: 3, done: true },
      { _tag: "Assistant", text: "No limiter is wired up." },
      { _tag: "ToolStart", id: "t1", name: "Edit", target: "src/billing.ts" },
      { _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null },
      { _tag: "GateRequested", gate: { id: "g1", kind: "command", title: "run a command", detail: "d", command: "npm test", allowLabel: "npm test", status: "pending" } },
      { _tag: "Done", costUsd: 0.38, tokens: 42_100 }
    ])
    expect(msg.streaming).toBe(false)
    expect(msg.parts.map((p) => p._tag)).toStrictEqual(["Thinking", "Text", "Tool", "Gate"])
  })

  it("setGateStatus flips a pending gate to approved without touching other parts", () => {
    const msg = fold([
      { _tag: "Assistant", text: "hi" },
      { _tag: "GateRequested", gate: { id: "g1", kind: "command", title: "t", detail: "d", command: "npm test", allowLabel: "npm test", status: "pending" } }
    ])
    const updated = setGateStatus(msg, "g1", "approved")
    const gatePart = updated.parts.find((p) => p._tag === "Gate")
    expect(gatePart && gatePart._tag === "Gate" && gatePart.gate.status).toBe("approved")
    expect(updated.parts[0]).toStrictEqual({ _tag: "Text", text: "hi" })
  })
})

describe("message constructors", () => {
  it("userMessage carries a single text part and is not streaming", () => {
    const msg = userMessage("m0", "hello", "2026-07-11T10:00:00.000Z")
    expect(msg.role).toBe("user")
    expect(msg.streaming).toBe(false)
    expect(msg.parts).toStrictEqual([{ _tag: "Text", text: "hello" }])
  })
})

describe("AskUserQuestion flow", () => {
  const now = "2026-07-11T10:00:00.000Z"
  const request: QuestionRequest = {
    id: "q1",
    questions: [
      {
        question: "Which strategy?",
        header: "Strategy",
        multiSelect: false,
        options: [
          { label: "Rotating", description: "secure" },
          { label: "Sliding", description: "simple" }
        ]
      }
    ]
  }

  it("folds QuestionRequested into a pending Question part", () => {
    const msg = applyStreamEvent(assistantMessage("a0", now), { _tag: "QuestionRequested", request })
    const part = msg.parts.find((p) => p._tag === "Question")
    expect(part).toBeDefined()
    expect(part).toMatchObject({ _tag: "Question", answers: null })
    // pendingQuestion surfaces it across the transcript.
    expect(pendingQuestion([msg])?.id).toBe("q1")
  })

  it("records answers and clears the pending question", () => {
    const asked = applyStreamEvent(assistantMessage("a0", now), { _tag: "QuestionRequested", request })
    const answered = setQuestionAnswers(asked, "q1", [{ selected: ["Rotating"], other: null }])
    const part = answered.parts.find((p) => p._tag === "Question")
    expect(part).toMatchObject({ answers: [{ selected: ["Rotating"], other: null }] })
    // No longer pending.
    expect(pendingQuestion([answered])).toBeNull()
  })
})

describe("settleStreaming", () => {
  const now = "2026-07-11T10:00:00.000Z"

  it("clears a turn (and its thinking part) left streaming when the app closed", () => {
    const stuck: Message = {
      id: "a0",
      role: "assistant",
      streaming: true,
      createdAt: now,
      parts: [
        { _tag: "Thinking", text: "reasoning", seconds: null, streaming: true },
        { _tag: "Text", text: "I'll take a look" }
      ]
    }
    const settled = settleStreaming(stuck)
    expect(settled.streaming).toBe(false)
    expect(settled.parts[0]).toMatchObject({ _tag: "Thinking", streaming: false })
    // The partial content is preserved.
    expect(settled.parts[1]).toStrictEqual({ _tag: "Text", text: "I'll take a look" })
  })

  it("returns a clean message unchanged (same reference)", () => {
    const clean = userMessage("m0", "hello", now)
    expect(settleStreaming(clean)).toBe(clean)
    const doneAssistant: Message = {
      id: "a1",
      role: "assistant",
      streaming: false,
      createdAt: now,
      parts: [{ _tag: "Text", text: "done" }]
    }
    expect(settleStreaming(doneAssistant)).toBe(doneAssistant)
  })
})

describe("settleLoaded", () => {
  const now = "2026-07-11T10:00:00.000Z"

  it("rejects an orphaned pending gate so its dead approve/deny buttons disappear", () => {
    const stuck: Message = {
      id: "a0",
      role: "assistant",
      streaming: false,
      createdAt: now,
      parts: [
        { _tag: "Text", text: "I'll run this" },
        {
          _tag: "Gate",
          gate: {
            id: "g_s_1",
            kind: "command",
            title: "run a command",
            detail: "Not in your allowlist.",
            allowLabel: "find",
            command: "find .",
            status: "pending"
          }
        }
      ]
    }
    const settled = settleLoaded(stuck)
    // The gate is resolved (rejected) — no live run can ever answer it.
    expect(settled.parts[1]).toMatchObject({ _tag: "Gate", gate: { status: "rejected" } })
    // Surrounding content is preserved.
    expect(settled.parts[0]).toStrictEqual({ _tag: "Text", text: "I'll run this" })
  })

  it("marks an orphaned pending question answered-with-nothing", () => {
    const stuck: Message = {
      id: "a1",
      role: "assistant",
      streaming: false,
      createdAt: now,
      parts: [
        {
          _tag: "Question",
          request: {
            id: "q_s_1",
            questions: [
              { question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }
            ]
          },
          answers: null
        }
      ]
    }
    const settled = settleLoaded(stuck)
    expect(settled.parts[0]).toMatchObject({ _tag: "Question", answers: [] })
    // pendingQuestion no longer surfaces it (so the composer returns).
    expect(pendingQuestion([settled])).toBe(null)
  })

  it("still clears a mid-stream turn (superset of settleStreaming)", () => {
    const stuck: Message = {
      id: "a2",
      role: "assistant",
      streaming: true,
      createdAt: now,
      parts: [{ _tag: "Thinking", text: "reasoning", seconds: null, streaming: true }]
    }
    const settled = settleLoaded(stuck)
    expect(settled.streaming).toBe(false)
    expect(settled.parts[0]).toMatchObject({ _tag: "Thinking", streaming: false })
  })

  it("returns a clean / already-resolved message unchanged (same reference)", () => {
    const resolved: Message = {
      id: "a3",
      role: "assistant",
      streaming: false,
      createdAt: now,
      parts: [
        {
          _tag: "Gate",
          gate: {
            id: "g_s_2",
            kind: "command",
            title: "run a command",
            detail: "Approved.",
            allowLabel: null,
            command: "ls",
            status: "approved"
          }
        }
      ]
    }
    expect(settleLoaded(resolved)).toBe(resolved)
    const cleanUser = userMessage("m1", "hi", now)
    expect(settleLoaded(cleanUser)).toBe(cleanUser)
  })
})

describe("Plan flow", () => {
  const now = "2026-07-12T10:00:00.000Z"

  const step = (over: Partial<Plan["steps"][number]> = {}): Plan["steps"][number] => ({
    id: "s1",
    number: "01",
    title: "Audit middleware",
    intent: "Understand the current auth flow",
    approach: ["Read session.ts", "Trace the token path"],
    kind: "step",
    condition: null,
    parentId: null,
    dependsOn: [],
    blocks: [],
    files: [],
    guards: [],
    diff: null,
    status: "proposed",
    flagged: false,
    ...over
  })

  const plan = (over: Partial<Plan> = {}): Plan => ({
    id: "plan_1",
    summary: "Refactor auth flow",
    graph: {
      nodes: [
        { id: "n0", label: "start", kind: "start", detail: null, stepId: null },
        { id: "n1", label: "token expired?", kind: "decision", detail: null, stepId: "s1" }
      ],
      edges: [{ id: "e0", from: "n0", to: "n1", label: null }]
    },
    steps: [step(), step({ id: "s2", number: "02", title: "Create TokenStore" })],
    comments: [],
    status: "proposed",
    raw: "# Refactor auth flow",
    ...over
  })

  it("decodes a full Plan content part (branch, files, guards, comments)", () => {
    const branchy = plan({
      steps: [
        step({
          id: "s4",
          number: "04",
          title: "Handle token refresh",
          kind: "branch",
          condition: "token expired",
          dependsOn: ["s3"],
          blocks: ["s5"]
        }),
        step({
          id: "s4a",
          number: "4a",
          title: "refresh() + retry on 401",
          kind: "branch-arm",
          parentId: "s4",
          files: [{ path: "src/auth/refresh.ts", change: "M", added: 18, removed: 0 }],
          guards: [{ text: "No refresh loop", status: "warn" }],
          diff: { added: 42, removed: 1 }
        })
      ],
      comments: [
        { id: "c1", stepId: "s4a", body: "guard the loop", author: "user", createdAt: now, routed: false }
      ]
    })
    expect(Either.isRight(decode(ContentPart, { _tag: "Plan", plan: branchy }))).toBe(true)
  })

  it("rejects an invalid plan status literal", () => {
    expect(Either.isLeft(decode(ContentPart, { _tag: "Plan", plan: plan({ status: "bogus" as never }) }))).toBe(true)
  })

  it("PlanProposed appends a plan part; PlanUpdated replaces it by id", () => {
    const proposed = applyStreamEvent(assistantMessage("a0", now), { _tag: "PlanProposed", plan: plan() })
    expect(proposed.parts).toHaveLength(1)
    expect(proposed.parts[0]).toMatchObject({ _tag: "Plan", plan: { id: "plan_1", status: "proposed" } })

    const revised = applyStreamEvent(proposed, { _tag: "PlanUpdated", plan: plan({ status: "revising" }) })
    expect(revised.parts).toHaveLength(1)
    expect(revised.parts[0]).toMatchObject({ _tag: "Plan", plan: { status: "revising" } })
  })

  it("pendingPlan surfaces the latest open plan, and nothing once approved", () => {
    const msg = applyStreamEvent(assistantMessage("a0", now), { _tag: "PlanProposed", plan: plan() })
    expect(pendingPlan([msg])?.id).toBe("plan_1")
    const approved = setPlanStatus(msg, "plan_1", "approved")
    expect(pendingPlan([approved])).toBe(null)
    // latestPlan keeps the plan visible after approval (the Plan Review tab).
    expect(latestPlan([approved])?.id).toBe("plan_1")
    expect(latestPlan([approved])?.status).toBe("approved")
  })

  it("addPlanComment appends the comment and flags its step", () => {
    const msg = applyStreamEvent(assistantMessage("a0", now), { _tag: "PlanProposed", plan: plan() })
    const comment: PlanComment = { id: "c1", stepId: "s2", body: "target main", author: "user", createdAt: now, routed: false }
    const commented = setPlanStepStatus(addPlanComment(msg, "plan_1", comment), "plan_1", "s2", "revising")
    const p = commented.parts[0]
    if (!p || p._tag !== "Plan") throw new Error("expected a plan part")
    expect(p.plan.comments).toHaveLength(1)
    expect(p.plan.steps[1]).toMatchObject({ id: "s2", flagged: true, status: "revising" })
  })

  it("settleLoaded stales an orphaned open plan (no dead approve buttons)", () => {
    const stuck: Message = {
      id: "a0",
      role: "assistant",
      streaming: false,
      createdAt: now,
      parts: [{ _tag: "Plan", plan: plan({ status: "revising" }) }]
    }
    const settled = settleLoaded(stuck)
    expect(settled.parts[0]).toMatchObject({ _tag: "Plan", plan: { status: "stale" } })
    expect(pendingPlan([settled])).toBe(null)
  })

  it("leaves an already-approved plan untouched", () => {
    const done: Message = {
      id: "a1",
      role: "assistant",
      streaming: false,
      createdAt: now,
      parts: [{ _tag: "Plan", plan: plan({ status: "approved" }) }]
    }
    expect(settleLoaded(done)).toBe(done)
  })
})
