import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ApprovalGate,
  ContentPart,
  Message,
  Skill,
  StreamEvent,
  Subagent,
  activityOf,
  REVIEWER_AGENT_ID,
  addPlanComment,
  applyReviewEvent,
  applyStreamEvent,
  nextReviewPhase,
  markChangedSteps,
  applySubagentEvent,
  agentChildren,
  agentPath,
  assistantMessage,
  findApprovedPlan,
  isSubagentEvent,
  latestPlan,
  resumePlanPrompt,
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

  it("decodes an Image part with an attachment", () => {
    expect(
      Either.isRight(
        decode(ContentPart, {
          _tag: "Image",
          attachment: { id: "a1", name: "login.png", mediaType: "image/png", data: "aGVsbG8=" }
        })
      )
    ).toBe(true)
  })

  it("rejects an Image part missing its attachment", () => {
    expect(Either.isLeft(decode(ContentPart, { _tag: "Image", url: "x" }))).toBe(true)
  })

  it("rejects an unknown part tag", () => {
    expect(Either.isLeft(decode(ContentPart, { _tag: "Nope", text: "x" }))).toBe(true)
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
  const now = "2026-07-11T10:00:00.000Z"
  const attachment = { id: "a1", name: "login.png", mediaType: "image/png", data: "aGVsbG8=" }

  it("userMessage carries a single text part and is not streaming", () => {
    const msg = userMessage("m0", "hello", now)
    expect(msg.role).toBe("user")
    expect(msg.streaming).toBe(false)
    expect(msg.parts).toStrictEqual([{ _tag: "Text", text: "hello" }])
  })

  it("userMessage prepends attached images before the text part", () => {
    const msg = userMessage("m0", "see this", now, [attachment])
    expect(msg.parts).toStrictEqual([
      { _tag: "Image", attachment },
      { _tag: "Text", text: "see this" }
    ])
  })

  it("userMessage omits the text part when the prompt is image-only", () => {
    const msg = userMessage("m0", "", now, [attachment])
    expect(msg.parts).toStrictEqual([{ _tag: "Image", attachment }])
  })

  it("a user turn with an image round-trips through the Message schema", () => {
    const msg = userMessage("m0", "here", now, [attachment])
    expect(Schema.decodeUnknownSync(Message)(Schema.encodeSync(Message)(msg))).toStrictEqual(msg)
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
    code: null,
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
    structured: true,
    raw: "# Refactor auth flow",
    ...over
  })

  it("markChangedSteps flags changed + new steps of a revision, leaving unchanged ones alone", () => {
    const prior = plan({
      steps: [step({ number: "01", title: "Audit" }), step({ id: "s2", number: "02", title: "TokenStore" })]
    })
    const revised = plan({
      id: "plan_2",
      steps: [
        step({ number: "01", title: "Audit" }), // identical → unchanged
        step({ id: "s2", number: "02", title: "TokenStore", intent: "now with a test fake" }), // content changed
        step({ id: "s3", number: "03", title: "Add tests" }) // new step
      ]
    })
    expect(markChangedSteps(prior, revised).steps.map((s) => s.changed)).toStrictEqual([false, true, true])
  })

  it("a PlanProposed after a prior plan in the same turn marks the revision's changed steps", () => {
    const first = plan({ id: "plan_1", steps: [step({ number: "01", title: "A" })] })
    const revised = plan({ id: "plan_2", steps: [step({ number: "01", title: "A (revised)" })] })
    const msg = [first, revised].reduce(
      (m, p) => applyStreamEvent(m, { _tag: "PlanProposed", plan: p }),
      assistantMessage("a0", now)
    )
    const planParts = msg.parts.filter((p) => p._tag === "Plan")
    expect(planParts).toHaveLength(2)
    // The first plan (no prior) is untouched; the revision marks its changed step.
    const firstPlan = planParts[0]
    const revisedPlan = planParts[1]
    if (firstPlan?._tag !== "Plan" || revisedPlan?._tag !== "Plan") throw new Error("expected plan parts")
    expect(firstPlan.plan.steps[0]?.changed).toBeUndefined()
    expect(revisedPlan.plan.steps[0]?.changed).toBe(true)
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

  it("decodes a plan step that predates the `code` field (defaults it to null)", () => {
    // A transcript persisted before per-step code samples: the step has no `code`
    // key. It MUST still decode (else the whole transcript blanks) — `code` → null.
    const legacyStep = { ...step() } as Record<string, unknown>
    delete legacyStep.code
    const legacyPlan = { ...plan({ steps: [legacyStep as never] }) }
    const decoded = decode(ContentPart, { _tag: "Plan", plan: legacyPlan })
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded) && decoded.right._tag === "Plan") {
      expect(decoded.right.plan.steps[0]!.code).toBeNull()
    }
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

  it("findApprovedPlan locates an approved plan and the message holding it", () => {
    const proposed = applyStreamEvent(assistantMessage("a0", now), {
      _tag: "PlanProposed",
      plan: plan()
    })
    // Only an APPROVED plan is under execution — a proposed one isn't.
    expect(findApprovedPlan([proposed])).toBe(null)

    const approved = setPlanStatus(proposed, "plan_1", "approved")
    // The plan stays in its own message while later turns append their own.
    const later = [approved, assistantMessage("a1", now), assistantMessage("a2", now)]
    const found = findApprovedPlan(later)
    expect(found?.plan.id).toBe("plan_1")
    // The message id is the point: it's what lets a later turn address the plan.
    expect(found?.messageId).toBe("a0")
  })

  it("findApprovedPlan returns null when no plan is approved", () => {
    expect(findApprovedPlan([])).toBe(null)
    expect(findApprovedPlan([assistantMessage("a0", now)])).toBe(null)
  })

  it("resumePlanPrompt embeds the plan and instructs implementation (for a post-restart re-drive)", () => {
    const p = plan()
    const prompt = resumePlanPrompt(p)
    expect(prompt).toContain(p.summary)
    expect(prompt).toMatch(/implement it now/i)
    expect(prompt.toLowerCase()).toContain("do not re-plan")
    // Includes the step titles so the resumed (memory-less) harness has the plan.
    expect(prompt).toContain(p.steps[0]!.title)
    if (p.raw) expect(prompt).toContain(p.raw)
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

describe("sub-agents", () => {
  it("decodes the Subagent schema and the new StreamEvent variants", () => {
    expect(
      Either.isRight(
        decode(Subagent, {
          id: "t1",
          name: "Explore",
          description: "Map the tab bar",
          parentId: null,
          status: "working",
          message: assistantMessage("t1", "")
        })
      )
    ).toBe(true)
    // An unknown status literal is rejected.
    expect(
      Either.isRight(
        decode(Subagent, {
          id: "t1",
          name: "Explore",
          description: "d",
          parentId: null,
          status: "paused",
          message: assistantMessage("t1", "")
        })
      )
    ).toBe(false)
    expect(
      Either.isRight(decode(StreamEvent, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "d", parentId: null }))
    ).toBe(true)
    expect(Either.isRight(decode(StreamEvent, { _tag: "SubagentEnded", id: "t1", status: "done" }))).toBe(true)
    // A content event may carry an optional agentId.
    expect(Either.isRight(decode(StreamEvent, { _tag: "Assistant", text: "hi", agentId: "t1" }))).toBe(true)
  })

  it("isSubagentEvent flags lifecycle + agentId-tagged events, not main-turn events", () => {
    expect(isSubagentEvent({ _tag: "SubagentStarted", id: "t1", name: "Explore", description: "d", parentId: null })).toBe(true)
    expect(isSubagentEvent({ _tag: "SubagentEnded", id: "t1", status: "done" })).toBe(true)
    expect(isSubagentEvent({ _tag: "Assistant", text: "child", agentId: "t1" })).toBe(true)
    // Same tag WITHOUT agentId belongs to the main turn.
    expect(isSubagentEvent({ _tag: "Assistant", text: "main" })).toBe(false)
    expect(isSubagentEvent({ _tag: "Done", costUsd: 0, tokens: 0 })).toBe(false)
  })

  it("SubagentStarted opens a working tab; agentId events accrue onto its own message", () => {
    let subs: ReadonlyArray<Subagent> = []
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "Map it", parentId: null })
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ id: "t1", name: "Explore", status: "working" })

    subs = applySubagentEvent(subs, { _tag: "ToolStart", id: "r1", name: "Read", target: "a.ts", agentId: "t1" })
    subs = applySubagentEvent(subs, { _tag: "Assistant", text: "found it", agentId: "t1" })
    const parts = subs[0]?.message.parts ?? []
    expect(parts.some((p) => p._tag === "Tool" && p.tool.name === "Read")).toBe(true)
    expect(parts.some((p) => p._tag === "Text" && p.text === "found it")).toBe(true)
  })

  it("routes each child's output to its own tab and ignores unknown ids", () => {
    let subs: ReadonlyArray<Subagent> = []
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "one", parentId: null })
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t2", name: "Explore", description: "two", parentId: null })
    subs = applySubagentEvent(subs, { _tag: "Assistant", text: "for t2", agentId: "t2" })
    // An event for a sub-agent that never started is a no-op, not a crash.
    const unchanged = applySubagentEvent(subs, { _tag: "Assistant", text: "ghost", agentId: "nope" })
    expect(unchanged).toBe(subs)
    expect(subs.find((s) => s.id === "t1")?.message.parts).toHaveLength(0)
    expect(subs.find((s) => s.id === "t2")?.message.parts).toHaveLength(1)
  })

  it("SubagentEnded keeps the tab (marks its status) so output stays readable", () => {
    let subs: ReadonlyArray<Subagent> = []
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "one", parentId: null })
    expect(subs[0]?.status).toBe("working")
    subs = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "t1", status: "done" })
    expect(subs).toHaveLength(1)
    expect(subs[0]?.status).toBe("done")
    // An error end is reflected the same way.
    subs = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "t1", status: "error" })
    expect(subs[0]?.status).toBe("error")
  })

  it("ignores a SubagentEnded for an unknown id (ambient task_notifications)", () => {
    let subs: ReadonlyArray<Subagent> = []
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "one", parentId: null })
    // `task_notification` fires for EVERY task, including ambient/workflow ones
    // whose tool_use_id never opened a tab — those must not churn the list.
    const same = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "ambient_task", status: "done" })
    expect(same).toBe(subs)
  })

  it("SubagentEnded settles the rolling message (no perpetual 'working' dots)", () => {
    let subs: ReadonlyArray<Subagent> = []
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "one", parentId: null })
    subs = applySubagentEvent(subs, { _tag: "Assistant", text: "found it", agentId: "t1" })
    // A sub-agent's message is born streaming, and `Done` (which would clear it)
    // is a MAIN-turn event that never reaches a sub-agent — so `SubagentEnded` is
    // the only thing that can settle it. Without this the tab pulses forever.
    expect(subs[0]?.message.streaming).toBe(true)
    subs = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "t1", status: "done" })
    expect(subs[0]?.message.streaming).toBe(false)
    // The output itself is untouched — the tab stays readable after it settles.
    expect(subs[0]?.message.parts).toHaveLength(1)
  })

  it("settles a still-streaming DESCENDANT's message when an ancestor ends", () => {
    let subs: ReadonlyArray<Subagent> = []
    const start = (id: string, parentId: string | null) =>
      applySubagentEvent(subs, { _tag: "SubagentStarted", id, name: id, description: "", parentId })
    subs = start("t1", null)
    subs = start("t1a", "t1")
    subs = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "t1", status: "error" })
    expect(subs.find((s) => s.id === "t1a")?.message.streaming).toBe(false)
  })

  it("opens a NESTED sub-agent's tab and routes its output to its own message", () => {
    let subs: ReadonlyArray<Subagent> = []
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t1", name: "Explore", description: "one", parentId: null })
    // t2 is spawned BY t1 — a second level.
    subs = applySubagentEvent(subs, { _tag: "SubagentStarted", id: "t2", name: "verify", description: "deep", parentId: "t1" })
    expect(subs).toHaveLength(2)
    expect(subs.find((s) => s.id === "t2")?.parentId).toBe("t1")

    // The SDK stamps the IMMEDIATE parent, so the nested agent's own output is
    // tagged with its own id and must land on its message, NOT its parent's.
    subs = applySubagentEvent(subs, { _tag: "Assistant", text: "from t2", agentId: "t2" })
    expect(subs.find((s) => s.id === "t1")?.message.parts).toHaveLength(0)
    expect(subs.find((s) => s.id === "t2")?.message.parts).toHaveLength(1)
  })

  it("agentChildren derives one level of the tree; agentPath gives the breadcrumb", () => {
    let subs: ReadonlyArray<Subagent> = []
    const start = (id: string, parentId: string | null) =>
      applySubagentEvent(subs, { _tag: "SubagentStarted", id, name: id, description: "", parentId })
    subs = start("t1", null)
    subs = start("t2", null)
    subs = start("t2a", "t2")
    subs = start("t2a1", "t2a")

    expect(agentChildren(subs, null).map((s) => s.id)).toStrictEqual(["t1", "t2"])
    expect(agentChildren(subs, "t2").map((s) => s.id)).toStrictEqual(["t2a"])
    expect(agentChildren(subs, "t1")).toStrictEqual([])
    expect(agentPath(subs, "t2a1").map((s) => s.id)).toStrictEqual(["t2", "t2a", "t2a1"])
    expect(agentPath(subs, "t1").map((s) => s.id)).toStrictEqual(["t1"])
    expect(agentPath(subs, "nope")).toStrictEqual([])
  })

  it("agentPath does not spin on a cyclic parent pointer", () => {
    // A malformed stream can't be ruled out at the type level — guard the walk.
    const cyclic: ReadonlyArray<Subagent> = [
      { id: "a", name: "a", description: "", parentId: "b", status: "working", message: assistantMessage("a", "") },
      { id: "b", name: "b", description: "", parentId: "a", status: "working", message: assistantMessage("b", "") }
    ]
    expect(agentPath(cyclic, "a").map((s) => s.id)).toStrictEqual(["b", "a"])
  })

  it("an ancestor ending settles still-working descendants (no ghost 'working' tabs)", () => {
    let subs: ReadonlyArray<Subagent> = []
    const start = (id: string, parentId: string | null) =>
      applySubagentEvent(subs, { _tag: "SubagentStarted", id, name: id, description: "", parentId })
    subs = start("t1", null)
    subs = start("t1a", "t1")
    subs = start("t1a1", "t1a")
    subs = start("t2", null)
    subs = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "t1a1", status: "done" })

    // t1 errors while t1a is still working — its whole subtree settles with it,
    // but an already-settled descendant keeps its own outcome, and the unrelated
    // t2 branch is untouched.
    subs = applySubagentEvent(subs, { _tag: "SubagentEnded", id: "t1", status: "error" })
    expect(subs.find((s) => s.id === "t1")?.status).toBe("error")
    expect(subs.find((s) => s.id === "t1a")?.status).toBe("error")
    expect(subs.find((s) => s.id === "t1a1")?.status).toBe("done")
    expect(subs.find((s) => s.id === "t2")?.status).toBe("working")
  })

  it("passes non-sub-agent events through untouched (callers can route unconditionally)", () => {
    const subs: ReadonlyArray<Subagent> = [
      { id: "t1", name: "Explore", description: "one", parentId: null, status: "working", message: assistantMessage("t1", "") }
    ]
    expect(applySubagentEvent(subs, { _tag: "Done", costUsd: 1, tokens: 2 })).toBe(subs)
  })
})

describe("activityOf", () => {
  const turn = (...parts: ReadonlyArray<ContentPart>): Message => ({
    id: "m1",
    role: "assistant",
    streaming: true,
    createdAt: "2026-07-11T10:00:00.000Z",
    parts
  })

  const tool = (name: string, target: string | null, status: "running" | "success" = "running") =>
    ({
      _tag: "Tool" as const,
      tool: { id: `t_${name}`, name, target, status, meta: null, diff: null, preview: null }
    })

  it("is null when the session is idle", () => {
    expect(activityOf([turn({ _tag: "Text", text: "done" })], "idle")).toBeNull()
  })

  it("only says 'Thinking' when NO tool is in flight", () => {
    // The whole complaint: "thinking" used to cover every moment of a run.
    expect(activityOf([turn({ _tag: "Text", text: "hm" })], "running")).toStrictEqual({
      kind: "thinking",
      verb: "Thinking",
      target: null
    })
  })

  it("reports the running command, not 'Thinking'", () => {
    expect(activityOf([turn(tool("Bash", "npm test -- auth"))], "running")).toStrictEqual({
      kind: "running",
      verb: "Running",
      target: "npm test -- auth"
    })
  })

  it("calls a PR watch 'Monitoring PR' and pulls out the number", () => {
    expect(activityOf([turn(tool("Bash", "gh pr checks 482 --watch"))], "running")).toStrictEqual({
      kind: "monitoring",
      verb: "Monitoring PR",
      target: "#482"
    })
    // No number in the command — still monitoring, just unqualified.
    expect(activityOf([turn(tool("Bash", "gh run watch"))], "running")?.kind).toBe("monitoring")
  })

  it("does NOT call routine gh commands 'Monitoring PR'", () => {
    // These finish in seconds and agents run them constantly; labelling them
    // "Monitoring PR" (an attention tone) would be a lie.
    for (const cmd of ["gh pr create --fill", "gh pr view 482", "gh run list"]) {
      expect(activityOf([turn(tool("Bash", cmd))], "running")).toStrictEqual({
        kind: "running",
        verb: "Running",
        target: cmd
      })
    }
  })

  it("calls a non-gh watcher 'Watching', not 'Monitoring PR'", () => {
    // `vitest --watch` never returns, so it isn't "Running" either — but it has
    // nothing to do with a PR.
    expect(activityOf([turn(tool("Bash", "vitest --watch"))], "running")).toStrictEqual({
      kind: "watching",
      verb: "Watching",
      target: "vitest --watch"
    })
  })

  it("reduces file tools to a basename", () => {
    expect(activityOf([turn(tool("Read", "packages/core/src/conversation.ts"))], "running")).toStrictEqual(
      { kind: "reading", verb: "Reading", target: "conversation.ts" }
    )
    expect(activityOf([turn(tool("Edit", "src/auth/session.ts"))], "running")?.kind).toBe("editing")
  })

  it("names sub-agent spawns as delegating", () => {
    expect(activityOf([turn(tool("Task", "Explore the plan pane"))], "running")).toStrictEqual({
      kind: "delegating",
      verb: "Delegating",
      target: "Explore the plan pane"
    })
  })

  it("falls back to an unknown tool's own name rather than 'Thinking'", () => {
    expect(activityOf([turn(tool("mcp__linear__list_issues", null))], "running")).toStrictEqual({
      kind: "running",
      verb: "mcp__linear__list_issues",
      target: null
    })
  })

  it("tracks the LAST running tool, ignoring finished ones", () => {
    const msg = turn(tool("Read", "a.ts", "success"), tool("Bash", "pnpm build"))
    expect(activityOf([msg], "running")?.target).toBe("pnpm build")
  })

  it("collapses a multi-line command to its first line", () => {
    expect(activityOf([turn(tool("Bash", "set -e\nnpm test"))], "running")?.target).toBe("set -e")
  })

  it("blocked-on-the-operator beats any in-flight tool", () => {
    const gate = turn(tool("Bash", "rm -rf /"), {
      _tag: "Gate",
      gate: {
        id: "g1",
        kind: "command",
        title: "run a command",
        detail: "Not in your allowlist.",
        command: "rm -rf /",
        allowLabel: "rm",
        status: "pending"
      }
    })
    expect(activityOf([gate], "running")).toStrictEqual({
      kind: "needs-input",
      verb: "Needs input",
      target: null
    })
  })

  it("surfaces needs-input / needs-approval even once the run has ENDED", () => {
    // A finished session blocked on you must not read as plain "idle".
    const gate = turn({
      _tag: "Gate",
      gate: {
        id: "g1",
        kind: "command",
        title: "run a command",
        detail: "Not in your allowlist.",
        command: "ls",
        allowLabel: "ls",
        status: "pending"
      }
    })
    expect(activityOf([gate], "idle")?.kind).toBe("needs-input")
  })
})

/**
 * The reviewer is a whole agent run surfaced in the sub-agent tab bar. These pin
 * the two pure reducers behind that: the tab's fold, and the phase the PR button
 * reports. Both are driven straight off the reviewer's normalized StreamEvents —
 * there is no percentage anywhere because nothing reports a total.
 */
describe("applyReviewEvent", () => {
  const started: StreamEvent = { _tag: "Started", sessionId: "review_s1" }

  it("opens a working tab on the first event", () => {
    const reviewer = applyReviewEvent(null, started)
    expect(reviewer?.id).toBe(REVIEWER_AGENT_ID)
    expect(reviewer?.name).toBe("Reviewer")
    expect(reviewer?.status).toBe("working")
  })

  it("accrues output onto one rolling message", () => {
    const a = applyReviewEvent(null, started)
    const b = applyReviewEvent(a, { _tag: "Assistant", text: "one " })
    const c = applyReviewEvent(b, { _tag: "Assistant", text: "two" })
    expect(JSON.stringify(c?.message.parts)).toContain("one two")
  })

  it("marks the tab done", () => {
    const a = applyReviewEvent(null, started)
    expect(applyReviewEvent(a, { _tag: "Done", costUsd: 0, tokens: 0 })?.status).toBe("done")
  })

  it("marks the tab errored", () => {
    const a = applyReviewEvent(null, started)
    expect(applyReviewEvent(a, { _tag: "Failed", message: "boom" })?.status).toBe("error")
  })

  // ReviewService publishes its own `Done` once a run produces a verdict, after
  // any `Failed` the harness emitted — a reviewer that refused still completed a
  // review (it lands as `note`), so "done" has to win.
  it("lets a trailing Done override a harness Failed", () => {
    const a = applyReviewEvent(null, started)
    const failed = applyReviewEvent(a, { _tag: "Failed", message: "turn failed" })
    expect(applyReviewEvent(failed, { _tag: "Done", costUsd: 0, tokens: 0 })?.status).toBe("done")
  })

  // Re-review publishes onto the same channel; an attached watcher would
  // otherwise show run 2 appended to run 1's transcript.
  it("rebuilds from scratch on a second Started", () => {
    const a = applyReviewEvent(null, started)
    const b = applyReviewEvent(a, { _tag: "Assistant", text: "stale output" })
    const done = applyReviewEvent(b, { _tag: "Done", costUsd: 0, tokens: 0 })

    const restarted = applyReviewEvent(done, started)
    expect(restarted?.status).toBe("working")
    expect(JSON.stringify(restarted?.message.parts)).not.toContain("stale output")
  })
})

describe("nextReviewPhase", () => {
  it("names what the reviewer is doing", () => {
    expect(nextReviewPhase("starting", { _tag: "ToolStart", id: "t", name: "Read", target: "a.ts" })).toBe("reading")
    expect(nextReviewPhase("reading", { _tag: "Thinking", text: "hm", seconds: null, done: false })).toBe("thinking")
    expect(nextReviewPhase("thinking", { _tag: "Assistant", text: "{" })).toBe("writing")
    expect(nextReviewPhase("writing", { _tag: "Done", costUsd: 0, tokens: 0 })).toBe("done")
    expect(nextReviewPhase("writing", { _tag: "Failed", message: "x" })).toBe("error")
  })

  // A reviewer runs tools back-to-back; flipping the label in the gap between
  // them would make the button strobe between two words.
  it("holds the phase across a ToolEnd", () => {
    expect(
      nextReviewPhase("reading", { _tag: "ToolEnd", id: "t", status: "success", meta: null, diff: null, preview: null })
    ).toBe("reading")
  })

  it("ignores events that say nothing about progress", () => {
    expect(nextReviewPhase("reading", { _tag: "Usage", tokens: 10 })).toBe("reading")
  })
})
