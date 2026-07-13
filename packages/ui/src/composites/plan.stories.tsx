import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Plan, PlanComment } from "@starbase/core"
import { PlanReview } from "../screens/plan-review.js"
import { PlanCard } from "./plan-card.js"
import { PlanStepDetail } from "./plan-step-detail.js"

/**
 * The Plan Review workspace — the design's screens 04 (visualise / step through)
 * and 05 (click a step for its spec). Use the **Interactive** story below to
 * exercise everything: click a flow node or a list row to open a step's spec,
 * comment on steps (from the spec or the rail), route the comments back as a
 * revision, and approve to flip the plan read-only.
 */

const GRAPH: Plan["graph"] = {
  nodes: [
    { id: "n0", label: "HTTP request", kind: "start", detail: null, stepId: null },
    { id: "n1", label: "authMiddleware", kind: "action", detail: "src/auth/session.ts", stepId: "s_03" },
    { id: "n2", label: "token expired?", kind: "decision", detail: null, stepId: "s_04" },
    { id: "n3", label: "refresh() + retry once", kind: "action", detail: "src/auth/refresh.ts", stepId: "s_4a" },
    { id: "n4", label: "proceed", kind: "action", detail: null, stepId: "s_4b" },
    { id: "n5", label: "single-flight guard?", kind: "decision", detail: null, stepId: "s_4a" },
    { id: "n6", label: "response", kind: "terminal", detail: null, stepId: null }
  ],
  edges: [
    { id: "e0", from: "n0", to: "n1", label: null },
    { id: "e1", from: "n1", to: "n2", label: null },
    { id: "e2", from: "n2", to: "n3", label: "yes" },
    { id: "e3", from: "n2", to: "n4", label: "no" },
    { id: "e4", from: "n3", to: "n5", label: null },
    { id: "e5", from: "n5", to: "n6", label: "once" },
    { id: "e6", from: "n4", to: "n6", label: null }
  ]
}

const basePlan = (over: Partial<Plan> = {}): Plan => ({
  id: "plan_seed",
  summary: "Refactor auth flow",
  graph: GRAPH,
  status: "proposed",
  raw: "# Refactor auth flow\n\nMove session token handling into a dedicated `TokenStore`, add a guarded 401-retry refresh path, update the tests, and open a PR.",
  comments: [
    { id: "c1", stepId: "s_4a", body: "The 401 retry should fire once — guard against a refresh loop on repeat failures.", author: "user", createdAt: "2026-07-12T10:00:00.000Z", routed: true },
    { id: "c2", stepId: "s_4a", body: "Adding a single-flight guard — retry increments an attempt counter and bails after one.", author: "agent", createdAt: "2026-07-12T10:01:00.000Z", routed: false }
  ],
  steps: [
    { id: "s_01", number: "01", title: "Audit session middleware", intent: "See how sessions read tokens today.", approach: ["Read session.ts", "Trace the token path"], kind: "step", condition: null, parentId: null, dependsOn: [], blocks: [], files: [{ path: "src/auth/memory-store.ts", change: "M", added: 0, removed: 0 }], guards: [], code: null, diff: null, status: "done", flagged: false },
    { id: "s_02", number: "02", title: "Create TokenStore module", intent: "A dedicated store for the token lifecycle.", approach: ["Add token-store.ts", "Expose get / set / refresh"], kind: "step", condition: null, parentId: null, dependsOn: ["01"], blocks: [], files: [{ path: "src/auth/token-store.ts", change: "A", added: 40, removed: 0 }], guards: [{ text: "Store is covered by unit tests", status: "ok" }], code: { lang: "ts", body: "export class TokenStore extends Effect.Service<TokenStore>()(\"TokenStore\", {\n  effect: Effect.gen(function* () {\n    const store = yield* KeyValueStore\n    return {\n      get: (id: string) => store.get(`token:${id}`),\n      refresh: (session: Session) =>\n        Effect.gen(function* () {\n          const next = yield* mintToken(session)\n          yield* store.set(`token:${session.id}`, next)\n          return next\n        })\n    }\n  })\n}) {}" }, diff: { added: 40, removed: 0 }, status: "done", flagged: false },
    { id: "s_03", number: "03", title: "Swap MemoryStore → TokenStore", intent: "Route the session through the new store.", approach: ["Replace the import", "Update the call sites"], kind: "step", condition: null, parentId: null, dependsOn: ["02"], blocks: [], files: [{ path: "src/auth/session.ts", change: "M", added: 8, removed: 3 }], guards: [], code: null, diff: { added: 8, removed: 3 }, status: "current", flagged: false },
    { id: "s_04", number: "04", title: "Handle token refresh", intent: "Decide the refresh path on expiry.", approach: [], kind: "branch", condition: "token expired?", parentId: null, dependsOn: ["03"], blocks: ["05"], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false },
    { id: "s_4a", number: "4a", title: "refresh() + retry on 401", intent: "Mint a new token and replay the request once.", approach: ["Detect a 401 from the downstream call", "Call refresh(session) to mint a new token", "Persist the token and replay the request once", "On a second failure, surface the 401"], kind: "branch-arm", condition: null, parentId: "s_04", dependsOn: ["03"], blocks: ["05"], files: [{ path: "src/auth/refresh.ts", change: "M", added: 18, removed: 0 }, { path: "src/auth/retry.ts", change: "A", added: 15, removed: 0 }], guards: [{ text: "New token written before the replay", status: "ok" }, { text: "Refresh fires at most once per request", status: "ok" }, { text: "No refresh loop on repeated 401", status: "warn" }, { text: "Concurrent requests share a single refresh", status: "open" }], code: null, diff: { added: 42, removed: 1 }, status: "revising", flagged: true },
    { id: "s_4b", number: "4b", title: "Proceed with request", intent: "Token still valid — carry on.", approach: [], kind: "branch-arm", condition: null, parentId: "s_04", dependsOn: [], blocks: [], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false },
    { id: "s_05", number: "05", title: "Update auth tests", intent: "Cover the new store + refresh path.", approach: ["Add token-store tests", "Add a 401-retry test"], kind: "step", condition: null, parentId: null, dependsOn: ["04"], blocks: [], files: [{ path: "src/auth/session.test.ts", change: "M", added: 24, removed: 2 }], guards: [], code: null, diff: { added: 24, removed: 2 }, status: "proposed", flagged: false },
    { id: "s_06", number: "06", title: "Open PR #482", intent: "Ship the refactor for review.", approach: ["Push the branch", "Open a PR against main"], kind: "step", condition: null, parentId: null, dependsOn: ["05"], blocks: [], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false }
  ],
  ...over
})

const meta: Meta = { title: "Plan/Plan Review" }
export default meta
type Story = StoryObj

let commentSeq = 100

/**
 * Fully interactive — the callbacks mutate local plan state so you can click
 * through the whole flow: open a step (flow node / list row), comment, route the
 * comments back as a revision, and approve.
 */
function Playground() {
  const [plan, setPlan] = useState<Plan>(basePlan)

  const onComment = (stepId: string, body: string) =>
    setPlan((p) => {
      const comment: PlanComment = {
        id: `c_${commentSeq++}`,
        stepId,
        body,
        author: "user",
        createdAt: "2026-07-12T10:05:00.000Z",
        routed: false
      }
      return {
        ...p,
        comments: [...p.comments, comment],
        steps: p.steps.map((s) => (s.id === stepId ? { ...s, flagged: true } : s))
      }
    })

  // Route open comments back to the "agent": mark them routed + add a canned reply
  // (in the real app this resolves the run's Deferred and the agent re-plans).
  const onRevise = () =>
    setPlan((p) => {
      const open = p.comments.filter((c) => !c.routed && c.author === "user")
      const replies: ReadonlyArray<PlanComment> = open.map((c, i) => ({
        id: `c_${commentSeq++}_${i}`,
        stepId: c.stepId,
        body: "Good catch — I'll fold that into the next revision.",
        author: "agent",
        createdAt: "2026-07-12T10:06:00.000Z",
        routed: false
      }))
      return {
        ...p,
        status: "revising",
        comments: [...p.comments.map((c) => (c.routed ? c : { ...c, routed: true })), ...replies]
      }
    })

  const onApprove = () => setPlan((p) => ({ ...p, status: "approved" }))

  return (
    <div className="flex h-[680px] w-full bg-editor">
      <PlanReview plan={plan} patch={DEMO_PATCH} onApprove={onApprove} onRevise={onRevise} onComment={onComment} />
    </div>
  )
}

// A small worktree diff so the per-step Changes rail renders real hunks for the
// steps that touch these files (token-store.ts, session.ts).
const DEMO_PATCH = `diff --git a/src/auth/token-store.ts b/src/auth/token-store.ts
new file mode 100644
--- /dev/null
+++ b/src/auth/token-store.ts
@@ -0,0 +1,6 @@
+export class TokenStore {
+  get(id: string) {}
+  set(id: string, token: Token) {}
+  refresh(session: Session) {}
+}
diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,4 +1,4 @@
-import { MemoryStore } from "./memory-store.js"
+import { TokenStore } from "./token-store.js"
 export const readSession = (id: string) =>
-  MemoryStore.get(id)
+  TokenStore.get(id)`

export const Interactive: Story = { render: () => <Playground /> }

export const Card: Story = {
  render: () => (
    <div className="w-[680px] bg-editor p-6">
      <PlanCard plan={basePlan()} onApprove={() => {}} onOpenReview={() => {}} />
    </div>
  )
}

export const CardRevising: Story = {
  render: () => (
    <div className="w-[680px] bg-editor p-6">
      <PlanCard plan={basePlan({ status: "revising" })} onApprove={() => {}} onOpenReview={() => {}} />
    </div>
  )
}

export const StepSpec: Story = {
  render: () => (
    <div className="flex h-[640px] w-[760px] bg-editor">
      <PlanStepDetail plan={basePlan()} step={basePlan().steps[4]!} onBack={() => {}} onSelect={() => {}} onComment={() => {}} />
    </div>
  )
}

export const Approved: Story = {
  render: () => (
    <div className="flex h-[600px] w-full bg-editor">
      <PlanReview plan={basePlan({ status: "approved" })} />
    </div>
  )
}

export const Empty: Story = {
  render: () => (
    <div className="flex h-[480px] w-full bg-editor">
      <PlanReview plan={null} />
    </div>
  )
}
