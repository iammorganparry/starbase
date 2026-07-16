import { describe, expect, it } from "vitest"
import {
  hasPlanBlock,
  parseFlow,
  parsePlan,
  parseStepCode,
  parseStepFlows,
  planModeInstructions
} from "./plan-parse.js"

/**
 * `parsePlan` turns the free-form plan text Claude emits via ExitPlanMode into a
 * structured Plan. We assert the outcomes an operator sees: steps in order,
 * branches nested under their parent, files/guards/deps parsed, the decision-flow
 * graph, and a never-lose-the-plan fallback for garbled input.
 */

const FLOW = `\`\`\`flow
start n0 "HTTP request"
action n1 "authMiddleware" file src/auth/session.ts
decision n2 "token expired?"
action n3 "refresh() + retry" step 4a
action n4 "proceed" step 4b
terminal n5 "response"
n0 -> n1
n1 -> n2
n2 -> n3 : yes
n2 -> n4 : no
n3 -> n5
n4 -> n5
n9 -> n5
\`\`\``

const STRUCTURED = `\`\`\`plan
summary: Refactor auth flow
01 Audit session middleware
  intent: Understand how sessions read tokens today
  approach: Read session.ts; Trace the token path
02 Create TokenStore module
  files: A src/auth/token-store.ts +40
03 Swap MemoryStore to TokenStore
  files: M src/auth/session.ts +8 -3
04 Handle token refresh
  branch: token expired?
  4a refresh() + retry on 401
    intent: Mint a new token and replay once
    files: M src/auth/refresh.ts +18; A src/auth/retry.ts +15
    guards: New token written before replay; No refresh loop (warn)
    depends: 03
    blocks: 05
  4b Proceed with request
    intent: Token still valid — carry on
05 Update auth tests
06 Open PR #482
\`\`\`

Here's the human-readable version: I'll refactor the auth flow…`

describe("parsePlan — structured block", () => {
  const plan = parsePlan(STRUCTURED, "plan_1")

  it("reads the summary and every step in order", () => {
    expect(plan.summary).toBe("Refactor auth flow")
    expect(plan.steps.map((s) => s.number)).toStrictEqual(["01", "02", "03", "04", "4a", "4b", "05", "06"])
    expect(plan.status).toBe("proposed")
    expect(plan.raw).toBe(STRUCTURED)
  })

  it("nests branch arms under the branch parent", () => {
    const branch = plan.steps.find((s) => s.number === "04")!
    expect(branch.kind).toBe("branch")
    expect(branch.condition).toBe("token expired?")
    const arm = plan.steps.find((s) => s.number === "4a")!
    expect(arm.kind).toBe("branch-arm")
    expect(arm.parentId).toBe(branch.id)
  })

  it("parses files (with a summed diff), guards, intent, approach and deps", () => {
    const arm = plan.steps.find((s) => s.number === "4a")!
    expect(arm.intent).toBe("Mint a new token and replay once")
    expect(arm.files).toStrictEqual([
      { path: "src/auth/refresh.ts", change: "M", added: 18, removed: 0 },
      { path: "src/auth/retry.ts", change: "A", added: 15, removed: 0 }
    ])
    expect(arm.diff).toStrictEqual({ added: 33, removed: 0 })
    expect(arm.guards).toStrictEqual([
      { text: "New token written before replay", status: "ok" },
      { text: "No refresh loop", status: "warn" }
    ])
    expect(arm.dependsOn).toStrictEqual(["03"])
    expect(arm.blocks).toStrictEqual(["05"])

    const audit = plan.steps.find((s) => s.number === "01")!
    expect(audit.approach).toStrictEqual(["Read session.ts", "Trace the token path"])
  })

  it("attaches the decision-flow graph from the ```flow block", () => {
    const withFlow = parsePlan(STRUCTURED + "\n" + FLOW, "plan_2")
    const graph = withFlow.graph
    expect(graph).not.toBeNull()
    expect(graph!.nodes.map((n) => n.kind)).toStrictEqual([
      "start",
      "action",
      "decision",
      "action",
      "action",
      "terminal"
    ])
    // The decision's out-edges carry the yes/no conditions.
    const decision = graph!.edges.filter((e) => e.from === "n2")
    expect(decision.map((e) => e.label)).toStrictEqual(["yes", "no"])
    // Node detail (file) + step link are parsed.
    const mw = graph!.nodes.find((n) => n.id === "n1")!
    expect(mw.detail).toBe("src/auth/session.ts")
    expect(graph!.nodes.find((n) => n.id === "n3")!.stepId).toBe("s_4a")
  })

  it("drops dangling edges that reference an undeclared node", () => {
    const graph = parseFlow(FLOW)!
    // `n9 -> n5` referenced n9 which was never declared → dropped.
    expect(graph.edges.some((e) => e.from === "n9")).toBe(false)
  })

  it("has no graph when the agent gave no ```flow block", () => {
    expect(parsePlan(STRUCTURED, "plan_3").graph).toBeNull()
  })
})

describe("parsePlan — fallback", () => {
  it("wraps unparseable markdown in a single step and keeps the raw text", () => {
    const raw = "# Ship the widget\n\n1. do a thing\n2. do another"
    const plan = parsePlan(raw, "plan_x")
    expect(plan.steps).toHaveLength(1)
    expect(plan.summary).toBe("Ship the widget")
    expect(plan.steps[0]!.title).toBe("Ship the widget")
    expect(plan.raw).toBe(raw)
    expect(plan.graph).toBeNull()
  })
})

describe("parseFlow", () => {
  it("returns null when there's no flow block", () => {
    expect(parseFlow("just some text")).toBeNull()
  })
})

describe("parseStepFlows — per-step flows", () => {
  const STEP_FLOW = `\`\`\`plan
summary: Refactor auth flow
01 Audit session middleware
03 Swap MemoryStore to TokenStore
04 Handle token refresh
\`\`\`

\`\`\`flow step 04
start n0 "request"
decision n1 "token expired?"
action n2 "refresh() + retry"
action n3 "proceed"
terminal n4 "response"
n0 -> n1
n1 -> n2 : yes
n1 -> n3 : no
n2 -> n4
n3 -> n4
\`\`\``

  it("keys each ```flow step NN``` block by its normalized step number", () => {
    const map = parseStepFlows(STEP_FLOW)
    expect([...map.keys()]).toStrictEqual(["04"])
    expect(map.get("04")!.nodes.map((n) => n.kind)).toStrictEqual([
      "start",
      "decision",
      "action",
      "action",
      "terminal"
    ])
  })

  it("attaches the flow onto the matching step (and leaves other steps without one)", () => {
    const plan = parsePlan(STEP_FLOW, "plan_f")
    expect(plan.steps.find((s) => s.number === "04")?.graph).not.toBeNull()
    expect(plan.steps.find((s) => s.number === "04")?.graph?.nodes.length).toBe(5)
    expect(plan.steps.find((s) => s.number === "01")?.graph ?? null).toBeNull()
  })

  it("does not treat a ```flow step NN``` block as a legacy plan-level flow or a code sample", () => {
    expect(parsePlan(STEP_FLOW, "plan_f").graph).toBeNull()
    expect(parseStepCode(STEP_FLOW).size).toBe(0)
  })
})

describe("parseStepCode", () => {
  const RAW = `\`\`\`plan
summary: x
02 Create TokenStore
\`\`\`

\`\`\`ts step 02
export class TokenStore {}
\`\`\`

\`\`\`step 3
const x = 1
\`\`\``

  it("links a fenced code block to its step by the `step NN` info string, capturing the language", () => {
    const map = parseStepCode(RAW)
    expect(map.get("02")).toStrictEqual({ lang: "ts", body: "export class TokenStore {}" })
  })

  it("normalizes the step number and treats a leading `step` token as no language", () => {
    const map = parseStepCode(RAW)
    expect(map.get("03")).toStrictEqual({ lang: null, body: "const x = 1" })
  })

  it("ignores plain code blocks with no step link (and the plan/flow blocks)", () => {
    expect(parseStepCode("```ts\nconst a = 1\n```").size).toBe(0)
  })

  it("attaches the sample onto the matching PlanStep in parsePlan", () => {
    const plan = parsePlan(RAW, "plan_1")
    expect(plan.steps.find((s) => s.number === "02")?.code).toStrictEqual({
      lang: "ts",
      body: "export class TokenStore {}"
    })
  })
})

describe("hasPlanBlock", () => {
  it("detects the fence, with or without an info string", () => {
    expect(hasPlanBlock("```plan\nsummary: x\n01 Step\n```")).toBe(true)
    expect(hasPlanBlock("prose first\n\n```plan\nsummary: x\n```\n\nmore prose")).toBe(true)
  })

  it("is false for a plan that skipped the fence", () => {
    expect(hasPlanBlock("## My plan\n\n1. Do a thing\n2. Do another")).toBe(false)
    // A plan carrying OTHER fences but not `plan` still counts as non-compliant.
    expect(hasPlanBlock("```ts\nconst x = 1\n```")).toBe(false)
    expect(hasPlanBlock("")).toBe(false)
  })
})

describe("parsePlan — the unstructured fallback", () => {
  const RAW_UNSTRUCTURED = "# Refactor auth\n\nFirst I'll extract the adapter, then migrate."

  it("flags the plan as unstructured and PRESERVES the raw markdown", () => {
    const plan = parsePlan(RAW_UNSTRUCTURED, "plan_1")
    // `raw` is the only surviving copy of the agent's work — the UI renders it.
    expect(plan.structured).toBe(false)
    expect(plan.raw).toBe(RAW_UNSTRUCTURED)
    expect(plan.summary).toBe("Refactor auth")
    expect(plan.steps).toHaveLength(1)
  })

  it("marks a properly fenced plan as structured", () => {
    const plan = parsePlan("```plan\nsummary: Do it\n01 First step\n  intent: because\n```", "plan_1")
    expect(plan.structured).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.title).toBe("First step")
  })
})

describe("planModeInstructions", () => {
  it("documents the plan + flow blocks and forbids execution", () => {
    expect(planModeInstructions).toContain("```plan")
    expect(planModeInstructions).toContain("```flow")
    expect(planModeInstructions).toMatch(/ExitPlanMode/)
    expect(planModeInstructions.toLowerCase()).toContain("do not edit")
  })

  it("documents the per-step code sample convention", () => {
    expect(planModeInstructions).toMatch(/step <NN>/)
    expect(planModeInstructions.toLowerCase()).toContain("code sample")
  })
})
