import type {
  Attachment,
  CliKind,
  PermissionMode,
  Plan,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent
} from "@starbase/core"
import { CliExecError } from "@starbase/core"
import { Context, Data, Effect, Layer } from "effect"

/** Parameters for starting a new agent turn against a CLI. */
export interface SessionSpec {
  readonly cli: CliKind
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly prompt: string
  /** Images the operator attached as context for this turn (empty when none). */
  readonly images: ReadonlyArray<Attachment>
  /** Resolved path to the harness binary, or null when it isn't installed. */
  readonly binPath: string | null
  /** The session's HITL permission mode (drives the harness's permission mode). */
  readonly mode: PermissionMode
  /** The model id to run, or null to use the harness default. */
  readonly model: string | null
  /**
   * The harness session id to RESUME from (persisted across app restarts), or
   * null for a fresh conversation. The adapter prefers its live in-memory id and
   * falls back to this, so "continue" reloads the full conversation even after a
   * restart cleared the in-memory resume map.
   */
  readonly resumeId: string | null
  /**
   * Force a brand-new harness conversation, ignoring the adapter's in-memory
   * resume map entirely (and not writing to it).
   *
   * `resumeId: null` is NOT enough on its own: the adapter prefers its live map
   * over the spec, so a repeated run under the same key silently resumes the
   * previous one. A one-shot run that must be a pure function of its prompt —
   * the adversarial reviewer — sets this.
   */
  readonly fresh?: boolean
  /**
   * This run must not mutate anything — no edits, no shell commands. Enforced by
   * the HARNESS, and each adapter says it in its own vocabulary (Claude: refuse
   * the write tools; Codex: a read-only sandbox).
   *
   * `ctx.canUseTool` is not sufficient on its own, in two independent ways:
   *  - it is a denylist over tool NAMES we recognise (`toPermissionRequest`
   *    returns null → allowed ungated), so a write-capable tool we don't know
   *    about is silently permitted; and
   *  - the Codex adapter never calls it at all (its exec model has no per-tool
   *    callback), so for Codex the callback is not a control surface whatsoever.
   *
   * Hence intent lives here rather than a list of Claude's tool names: a spec
   * field only one adapter understands is a guarantee only one adapter keeps.
   */
  readonly readOnly?: boolean
  /**
   * This agent runs with nobody watching, so apply the protections that implies.
   *
   * Two mechanisms, deliberately kept separate because they fail differently:
   *
   *  1. **File-tool confinement to `cwd`** (`confinement.ts`). Read tools are
   *     never gated — `toPermissionRequest` returns null for them — so without
   *     this an agent reads anything on disk. A planning proposer was observed
   *     doing exactly that, pulling 403 lines of an unrelated private repository
   *     into its context. Pure, and works on every platform.
   *  2. **A credential denylist sandbox** (`sandbox.ts`). The check above cannot
   *     see a shell, and a plan step needs Bash to build and test, so `cat
   *     ~/.ssh/id_rsa` walked straight through it. The sandbox blocks that at the
   *     OS level — but it needs platform support and degrades silently when
   *     absent, which is why (1) is kept rather than replaced.
   *
   * NEITHER IS CONFINEMENT TO THE WORKTREE, and the gap is measured rather than
   * assumed: `denyRead` is absolute with no carve-out, so denying `~` also denies
   * a worktree under `~`. A step that cannot read its own repository is useless.
   * Anything outside the denylist and outside the file tools remains reachable.
   *
   * Deliberately NOT set for the operator's own session: they are watching, and a
   * coding agent that cannot read a sibling repo on request is less useful.
   */
  readonly unattended?: boolean
}

/** What the agent is asking permission to do, surfaced before it acts. */
export interface PermissionRequest {
  readonly kind: "command" | "edit"
  /** Tool name, e.g. "Edit" or "Bash". */
  readonly tool: string
  readonly target: string | null
  /** The shell command awaiting approval, when `kind === "command"`. */
  readonly command: string | null
}

export type PermissionDecision = "allow" | "deny"

/**
 * A permission resolver the adapter calls before any gated action. The
 * `AgentRunner` supplies one that applies the session's HITL mode/allowlist and,
 * when it must pause, emits an approval gate and awaits the operator. Mirrors the
 * real `claude -p` `canUseTool` callback, keeping the adapter harness-agnostic.
 */
export type CanUseTool = (req: PermissionRequest) => Effect.Effect<PermissionDecision>

/**
 * Present a group of structured questions to the user and await the answers
 * (mirrors the SDK's AskUserQuestion tool). The `AgentRunner` supplies one that
 * emits a `QuestionRequested` event and parks until the user submits.
 */
export type AskQuestion = (
  request: QuestionRequest
) => Effect.Effect<ReadonlyArray<QuestionAnswer>>

/**
 * The operator's verdict on a proposed plan (mirrors ExitPlanMode's approval):
 * - `Approve` — start execution under `mode` (the session's restored exec mode),
 * - `Revise` — keep planning, addressing `feedback` (bundled step comments),
 * - `Reject` — abandon the plan (e.g. the run was stopped).
 */
export type PlanDecision = Data.TaggedEnum<{
  Approve: { readonly mode: PermissionMode }
  Revise: { readonly feedback: string }
  Reject: {}
}>
export const PlanDecision = Data.taggedEnum<PlanDecision>()

/**
 * Present a structured plan (from ExitPlanMode) and await the operator's
 * decision. The `AgentRunner` supplies one that emits `PlanProposed` and parks
 * until approve/revise/reject, mirroring `askQuestion`.
 */
export type ProposePlan = (plan: Plan) => Effect.Effect<PlanDecision>

/**
 * What the adapter is handed for a run: an ordered `emit` sink for normalized
 * events, the `canUseTool` gate, `askQuestion` for structured input, and
 * `proposePlan` for plan-mode review. Because the adapter drives a single fiber
 * that interleaves these in program order, the transcript order (where a
 * gate/question/plan lands) is deterministic.
 */
/**
 * Stop ONE background task by its harness task id.
 *
 * Per-run rather than a method on the adapter because the handle only exists
 * while the harness process is alive — a background task cannot outlive the
 * process that owns it, so a stale handle would be worse than none.
 */
export type StopBackgroundTask = (taskId: string) => Promise<void>

export interface AgentContext {
  readonly emit: (event: StreamEvent) => Effect.Effect<void>
  readonly canUseTool: CanUseTool
  readonly askQuestion: AskQuestion
  readonly proposePlan: ProposePlan
  /**
   * Publish a handle the operator's "Stop" button can reach. Adapters whose
   * harness has no per-task cancellation (codex, opencode — both can only abort
   * a whole turn) simply never call this, and the UI reports the capability as
   * unsupported rather than offering a button that does nothing.
   */
  readonly registerBackgroundStop: (stop: StopBackgroundTask) => Effect.Effect<void>
}

/**
 * The contract for wrapping a native coding CLI. A real headless adapter
 * (`claude -p --output-format stream-json`, codex/cursor equivalents) parses its
 * CLI's stream into normalized `StreamEvent`s (via `ctx.emit`) and calls
 * `ctx.canUseTool` before gated actions. Everything downstream (persistence, UI)
 * only sees `StreamEvent`, so the experience is identical across harnesses.
 */
export interface CliAdapterShape {
  readonly run: (
    sessionId: string,
    spec: SessionSpec,
    ctx: AgentContext
  ) => Effect.Effect<void, CliExecError>
  readonly stop: (sessionId: string) => Effect.Effect<void, CliExecError>
}

export class CliAdapter extends Context.Tag("@starbase/CliAdapter")<
  CliAdapter,
  CliAdapterShape
>() {}

/**
 * A deterministic scripted plan — the design's "Refactor auth flow" (6 steps,
 * one branch), used by the plan-mode e2e/tests. `rev` bumps the id/summary so a
 * revision cycle yields a distinct plan part.
 */
/**
 * The decision flow for the branch step (04 "Handle token refresh") — flows now
 * live per-step, so it hangs off that step rather than the whole plan.
 */
const refreshFlow: NonNullable<Plan["steps"][number]["graph"]> = {
  nodes: [
    { id: "n0", label: "HTTP request", kind: "start", detail: null, stepId: null },
    { id: "n1", label: "authMiddleware", kind: "action", detail: "src/auth/session.ts", stepId: null },
    { id: "n2", label: "token expired?", kind: "decision", detail: null, stepId: null },
    { id: "n3", label: "refresh() + retry once", kind: "action", detail: "src/auth/refresh.ts", stepId: null },
    { id: "n4", label: "proceed", kind: "action", detail: null, stepId: null },
    { id: "n5", label: "response", kind: "terminal", detail: null, stepId: null }
  ],
  edges: [
    { id: "e0", from: "n0", to: "n1", label: null },
    { id: "e1", from: "n1", to: "n2", label: null },
    { id: "e2", from: "n2", to: "n3", label: "yes" },
    { id: "e3", from: "n2", to: "n4", label: "no" },
    { id: "e4", from: "n3", to: "n5", label: null },
    { id: "e5", from: "n4", to: "n5", label: null }
  ]
}

export const scriptedPlan = (sessionId: string, rev: number): Plan => ({
  id: `plan_${sessionId}_${rev}`,
  summary: rev > 1 ? "Refactor auth flow (revised)" : "Refactor auth flow",
  structured: true,
  graph: null,
  steps: [
    { id: "s_01", number: "01", title: "Audit session middleware", intent: "See how sessions read tokens today.", approach: ["Read session.ts", "Trace the token path"], kind: "step", condition: null, parentId: null, dependsOn: [], blocks: [], files: [{ path: "src/auth/memory-store.ts", change: "M", added: 0, removed: 0 }], guards: [], code: null, diff: null, status: "proposed", flagged: false },
    { id: "s_02", number: "02", title: "Create TokenStore module", intent: "A dedicated store for token lifecycle.", approach: ["Add token-store.ts", "Expose get/set/refresh"], kind: "step", condition: null, parentId: null, dependsOn: ["01"], blocks: [], files: [{ path: "src/auth/token-store.ts", change: "A", added: 40, removed: 0 }], guards: [{ text: "Store is covered by tests", status: "ok" }], code: { lang: "ts", body: "export class TokenStore extends Effect.Service<TokenStore>()(\"TokenStore\", {\n  effect: Effect.gen(function* () {\n    const store = yield* KeyValueStore\n    return {\n      get: (id: string) =>\n        store.get(`token:${id}`).pipe(Effect.map(Option.getOrNull)),\n      set: (id: string, token: Token) =>\n        store.set(`token:${id}`, token),\n      refresh: (session: Session) =>\n        Effect.gen(function* () {\n          const next = yield* mintToken(session)\n          yield* store.set(`token:${session.id}`, next)\n          return next\n        })\n    }\n  })\n}) {}" }, diff: { added: 40, removed: 0 }, status: "proposed", flagged: false },
    { id: "s_03", number: "03", title: "Swap MemoryStore → TokenStore", intent: "Route the session through the new store.", approach: ["Replace the import", "Update call sites"], kind: "step", condition: null, parentId: null, dependsOn: ["02"], blocks: [], files: [{ path: "src/auth/session.ts", change: "M", added: 8, removed: 3 }], guards: [], code: { lang: "ts", body: "-import { MemoryStore } from \"./memory-store.js\"\n+import { TokenStore } from \"./token-store.js\"\n\n export const readSession = (id: string) =>\n   Effect.gen(function* () {\n-    const token = yield* MemoryStore.get(id)\n+    const token = yield* TokenStore.get(id)\n     return decode(token)\n   })" }, diff: { added: 8, removed: 3 }, status: "current", flagged: false },
    { id: "s_04", number: "04", title: "Handle token refresh", intent: "Decide the refresh path on expiry.", approach: [], kind: "branch", condition: "token expired?", parentId: null, dependsOn: ["03"], blocks: ["05"], files: [], guards: [], code: null, graph: refreshFlow, diff: null, status: "proposed", flagged: false },
    { id: "s_4a", number: "4a", title: "refresh() + retry on 401", intent: "Mint a new token and replay once.", approach: ["Detect a 401", "Call refresh(session)", "Replay the request once"], kind: "branch-arm", condition: null, parentId: "s_04", dependsOn: ["03"], blocks: ["05"], files: [{ path: "src/auth/refresh.ts", change: "M", added: 18, removed: 0 }, { path: "src/auth/retry.ts", change: "A", added: 15, removed: 0 }], guards: [{ text: "New token written before the replay", status: "ok" }, { text: "Refresh fires at most once per request", status: "ok" }, { text: "No refresh loop on repeated 401", status: "warn" }, { text: "Concurrent requests share a single refresh", status: "open" }], code: { lang: "ts", body: "export const withRetry = (req: Request, session: Session) =>\n  send(req).pipe(\n    Effect.catchIf(\n      (e) => e.status === 401,\n      () =>\n        Effect.gen(function* () {\n          yield* TokenStore.refresh(session) // once — guarded by a single-flight\n          return yield* send(req)\n        })\n    )\n  )" }, diff: { added: 42, removed: 1 }, status: "proposed", flagged: false },
    { id: "s_4b", number: "4b", title: "Proceed with request", intent: "Token still valid — carry on.", approach: [], kind: "branch-arm", condition: null, parentId: "s_04", dependsOn: [], blocks: [], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false },
    { id: "s_05", number: "05", title: "Update auth tests", intent: "Cover the new store + refresh path.", approach: ["Add token-store tests", "Add a 401-retry test"], kind: "step", condition: null, parentId: null, dependsOn: ["04"], blocks: [], files: [{ path: "src/auth/session.test.ts", change: "M", added: 24, removed: 2 }], guards: [], code: { lang: "ts", body: "it(\"refreshes once and replays on a 401\", () =>\n  Effect.gen(function* () {\n    const session = yield* seedSession({ expired: true })\n    const res = yield* withRetry(makeRequest(), session)\n    expect(res.status).toBe(200)\n    expect(refreshSpy).toHaveBeenCalledTimes(1) // no refresh loop\n  }).pipe(Effect.provide(TestTokenStore), Effect.runPromise))" }, diff: { added: 24, removed: 2 }, status: "proposed", flagged: false },
    { id: "s_06", number: "06", title: "Open PR #482", intent: "Ship the refactor for review.", approach: ["Push the branch", "Open a PR against main"], kind: "step", condition: null, parentId: null, dependsOn: ["05"], blocks: [], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false }
  ],
  comments: [],
  status: "proposed",
  raw: "# Refactor auth flow\n\nMove session token handling into a dedicated `TokenStore`, add a guarded 401-retry refresh path, update the tests, and open a PR."
})

/**
 * The scripted run body — a deterministic sequence (thinking, reads, a gated
 * edit, a gated shell command) driving the full contract without a real process.
 * Reused by both `makeScriptedCliAdapter`'s Layer and the harness dispatcher's
 * fallback (tests / e2e / no-CLI-installed). `delayMs` paces the stream.
 *
 * Markers in the prompt drive the interactive flows: `[[ask]]` → AskUserQuestion,
 * `[[plan]]` → propose a plan and honour the approve/revise decision.
 */
export const scriptedRun =
  (delayMs: number): CliAdapterShape["run"] =>
  (sessionId, spec, { emit, canUseTool, askQuestion, proposePlan, registerBackgroundStop }) =>
    Effect.gen(function* () {
      const pause = delayMs > 0 ? Effect.sleep(`${delayMs} millis`) : Effect.void

      yield* emit({ _tag: "Started", sessionId })
      yield* pause

      // A `[[background]]` marker starts a background task that keeps running
      // after the turn ends — the case the dock exists for, and the only way to
      // drive it end-to-end without a real harness. The registered stop handle
      // settles it the way a real one does: by reporting the outcome back through
      // the same signals, rather than mutating state behind the registry's back.
      if (spec.prompt.includes("[[background]]")) {
        const taskId = `bgtask_${sessionId}`
        yield* registerBackgroundStop(async (id) => {
          if (id !== taskId) return
          await Effect.runPromise(
            emit({
              _tag: "BackgroundTaskSettled",
              id: taskId,
              status: "stopped",
              summary: "Stopped by the operator.",
              outputFile: null
            }).pipe(Effect.zipRight(emit({ _tag: "BackgroundTasksChanged", ids: [] })))
          )
        })
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({
          _tag: "BackgroundTaskProgress",
          id: taskId,
          description: "Watching the test suite",
          tokens: 1200,
          toolUses: 3,
          durationMs: 12_000,
          lastTool: "Bash"
        })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        // The turn ENDS while the task runs on — exactly the situation that made
        // this work invisible before the dock existed.
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[plan]]` marker drives plan mode: propose a plan, then execute on
      // approval or re-propose a revised one on revise (one cycle max, for tests).
      if (spec.prompt.includes("[[plan]]") || spec.mode === "plan") {
        yield* emit({ _tag: "Thinking", text: "Mapping out the work before touching anything.", seconds: 3, done: true })
        yield* pause
        let rev = 1
        while (true) {
          const decision = yield* proposePlan(scriptedPlan(sessionId, rev))
          if (decision._tag === "Approve") {
            yield* emit({ _tag: "Assistant", text: "Plan approved — executing the steps." })
            yield* pause
            // Each edit's path matches a plan step's files, so the runner marks that
            // step done — exercising the execution → plan-progress linkage.
            const edits: ReadonlyArray<{ id: string; path: string; preview: string; diff: { added: number; removed: number } }> = [
              { id: "plan-edit-1", path: "src/auth/token-store.ts", preview: "+export class TokenStore {\n+  // …\n+}", diff: { added: 40, removed: 0 } },
              { id: "plan-edit-2", path: "src/auth/session.ts", preview: "-import { MemoryStore } from \"./memory-store.js\"\n+import { TokenStore } from \"./token-store.js\"", diff: { added: 8, removed: 3 } },
              { id: "plan-edit-3", path: "src/auth/session.test.ts", preview: "+it(\"refreshes once and replays on a 401\", () => {\n+  // …\n+})", diff: { added: 24, removed: 2 } }
            ]
            for (const e of edits) {
              yield* emit({ _tag: "ToolStart", id: e.id, name: "Write", target: e.path })
              yield* pause
              yield* emit({ _tag: "ToolEnd", id: e.id, status: "success", meta: null, diff: e.diff, preview: e.preview })
              yield* pause
            }
            yield* emit({ _tag: "Assistant", text: "Steps 2, 3 and 5 are done." })
            break
          }
          if (decision._tag === "Reject" || rev >= 2) {
            yield* emit({ _tag: "Assistant", text: "Holding here until you're ready." })
            break
          }
          yield* emit({ _tag: "Assistant", text: "Good call — revising the plan to guard the refresh loop." })
          yield* pause
          rev += 1
        }
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[storm]]` marker emits a run of consecutive tool calls (no text
      // between) so the transcript's collapse-to-latest grouping can be exercised.
      if (spec.prompt.includes("[[storm]]")) {
        yield* emit({ _tag: "Thinking", text: "Scanning the codebase.", seconds: 2, done: true })
        yield* pause
        for (let i = 1; i <= 4; i++) {
          yield* emit({ _tag: "ToolStart", id: `read-${i}`, name: "Read", target: `src/file-${i}.ts` })
          yield* pause
          yield* emit({ _tag: "ToolEnd", id: `read-${i}`, status: "success", meta: `${i * 10} lines`, diff: null, preview: null })
          yield* pause
        }
        yield* emit({ _tag: "Assistant", text: "Scanned four files." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[ask]]` marker in the prompt drives the AskUserQuestion flow (used by
      // the question e2e/tests) instead of the default gated edit/command flow.
      if (spec.prompt.includes("[[ask]]")) {
        yield* emit({
          _tag: "Thinking",
          text: "Before I start I need a couple of decisions.",
          seconds: 2,
          done: true
        })
        yield* pause
        const answers = yield* askQuestion({
          id: `q_${sessionId}`,
          questions: [
            {
              question: "Which token strategy should the store use?",
              header: "Strategy",
              multiSelect: false,
              options: [
                { label: "Rotating refresh tokens", description: "New refresh token on every use — most secure." },
                { label: "Sliding session", description: "Extend expiry on activity, single long-lived token." },
                { label: "Short-lived access + refresh", description: "15-min access, 7-day refresh. The common default." }
              ]
            },
            {
              question: "Which surfaces should adopt the new store?",
              header: "Surfaces",
              multiSelect: true,
              options: [
                { label: "HTTP middleware", description: "Express session guard on the API." },
                { label: "WebSocket handshake", description: "Auth on the realtime channel." },
                { label: "Background workers", description: "Queue consumers acting on a user's behalf." }
              ]
            }
          ]
        })
        const summary = answers
          .map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(", ") || "—")
          .join(" · ")
        yield* emit({ _tag: "Assistant", text: `Got it — starting with: ${summary}.` })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }
      yield* emit({ _tag: "Thinking", text: "No limiter middleware exists yet. ", seconds: null, done: false })
      yield* pause
      yield* emit({
        _tag: "Thinking",
        text: "I'll reuse the token-bucket in lib/ratelimit.ts, apply it to POST /refund, then add a 429 test.",
        seconds: 6,
        done: true
      })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "read-1", name: "Read", target: "src/routes/billing.ts" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "read-1", status: "success", meta: "142 lines", diff: null, preview: null })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "grep-1", name: "Grep", target: "rateLimit|tokenBucket" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "grep-1", status: "success", meta: "0 hits", diff: null, preview: null })
      yield* pause
      yield* emit({
        _tag: "Assistant",
        text: "No limiter is wired up. Adding the middleware to the refund route and a matching test."
      })
      yield* pause

      // ── Edit (gated on `kind === "edit"`) ──
      const editDecision = yield* canUseTool({
        kind: "edit",
        tool: "Edit",
        target: "src/routes/billing.ts",
        command: null
      })
      if (editDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "edit-1", name: "Edit", target: "src/routes/billing.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "edit-1",
          status: "success",
          meta: null,
          diff: { added: 7, removed: 0 },
          preview: "61  + router.post('/refund', rateLimit(5, '1m'), requireAuth, refundHandler)"
        })
      } else {
        yield* emit({ _tag: "Assistant", text: "Holding the edit until you approve it." })
      }
      yield* pause

      // ── Shell command (gated on `kind === "command"`) ──
      const cmdDecision = yield* canUseTool({
        kind: "command",
        tool: "Bash",
        target: "npm test -- billing",
        command: "npm test -- billing"
      })
      if (cmdDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "bash-1", name: "Bash", target: "npm test -- billing" })
        yield* pause
        yield* emit({ _tag: "ToolEnd", id: "bash-1", status: "success", meta: "1 passed", diff: null, preview: null })
      } else {
        yield* emit({ _tag: "Assistant", text: "Left the tests unrun for now." })
      }
      yield* pause
      yield* emit({ _tag: "Done", costUsd: 0.38, tokens: 42_100 })
    })

/**
 * A deterministic adapter driving the full contract without a real process —
 * the tests/e2e/fallback path. `delayMs` paces the stream.
 */
/**
 * Whether an event is a CHILD run's own lifecycle, and must not reach the
 * parent stream.
 *
 * `Started`, `Done` and `Failed` describe a whole run. When an orchestrator
 * (the planning round, the plan executor) drives a nested `CliAdapter.run`, the
 * nested run emits its own — and unlike every other event they carry no
 * `agentId`, so they cannot be scoped to a subagent and arrive looking exactly
 * like the PARENT finishing.
 *
 * The renderer believes them: one `Done` ends the turn, tears down the stream
 * actor and interrupts the fiber behind it. Measured, this killed the plan
 * executor midway through step 2 and the adversarial round straight after the
 * proposer — the orchestrator was cut off by its own first child reporting
 * success.
 *
 * So orchestrators swallow these and emit their own once, at the real end.
 */
export const isChildLifecycle = (event: StreamEvent): boolean =>
  event._tag === "Started" || event._tag === "Done" || event._tag === "Failed"

export const makeScriptedCliAdapter = (delayMs: number): Layer.Layer<CliAdapter> =>
  Layer.succeed(CliAdapter, CliAdapter.of({ run: scriptedRun(delayMs), stop: () => Effect.void }))

/** The default scripted adapter, paced for a visible streaming cadence. */
export const ScriptedCliAdapterLive = makeScriptedCliAdapter(320)
