import type { Plan, PlanStep, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import { Effect, Fiber, Layer, Stream, TestClock, TestContext } from "effect"
import { describe, expect, it } from "vitest"
import { CliAdapter, makeScriptedCliAdapter } from "./adapter.js"
import type { CliAdapterShape } from "./adapter.js"
import { MAX_STEP_ATTEMPTS, parseStepVerdict, PlanExecutor, STEP_TIMEOUT } from "./plan-executor.js"
import { stepPrompt } from "./plan-executor-prompt.js"

const step = (over: Partial<PlanStep> & { id: string; number: string }): PlanStep =>
  ({
    title: `Step ${over.number}`,
    intent: "",
    approach: [],
    kind: "step",
    condition: null,
    parentId: null,
    dependsOn: [],
    blocks: [],
    files: [],
    guards: [],
    ...over
  }) as PlanStep

const planOf = (steps: ReadonlyArray<PlanStep>): Plan =>
  ({ id: "p1", summary: "", structured: true, graph: null, steps }) as Plan

/** Records which (cli, model) each step actually ran on, in order. */
const recording = (
  onRun?: (spec: { cli: string; model: string | null; mode: string }) => Effect.Effect<void>
) => {
  const ran: Array<{
    cli: string
    model: string | null
    mode: string
    prompt: string
  }> = []
  const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
    run: (_id, spec, ctx) =>
      Effect.gen(function* () {
        ran.push({
          cli: spec.cli,
          model: spec.model,
          mode: spec.mode,
          prompt: spec.prompt
        })
        if (onRun) yield* onRun({ cli: spec.cli, model: spec.model, mode: spec.mode })
        yield* ctx.emit({
          _tag: "Assistant",
          text: "done",
          agentId: undefined
        })
      }),
    stop: () => Effect.void
  } as CliAdapterShape)
  return { ran, layer }
}

const execute = (
  plan: Plan,
  layer: Layer.Layer<CliAdapter>,
  available = [
    { cli: "claude" as const, model: "opus" },
    { cli: "codex" as const, model: "gpt-5.6-sol" }
  ],
  executionMode?: "auto"
) =>
  Effect.gen(function* () {
    const svc = yield* PlanExecutor
    return yield* svc
      .run({
        sessionId: "s1",
        repo: "widget",
        branch: "starbase/x",
        cwd: "/tmp/wt",
        plan,
        available,
        fallback: { cli: "claude", model: "opus" },
        binPathFor: () => "/usr/bin/fake",
        executionMode
      })
      .pipe(
        Stream.runCollect,
        Effect.map((c) => [...c])
      )
  }).pipe(Effect.provide(PlanExecutor.Default), Effect.provide(layer), Effect.runPromise)

describe("PlanExecutor", () => {
  it("runs each step on the harness the plan assigned to it", async () => {
    // The whole point of the feature: without this the round's per-step
    // assignment is decoration.
    const { ran, layer } = recording()
    await execute(
      planOf([
        step({
          id: "a",
          number: "01",
          assignee: { cli: "codex", model: "gpt-5.6-sol", reason: "schema" }
        }),
        step({
          id: "b",
          number: "02",
          assignee: { cli: "claude", model: "opus", reason: "ui" }
        })
      ]),
      layer
    )
    expect(ran.map((r) => `${r.cli}:${r.model}`)).toStrictEqual([
      "codex:gpt-5.6-sol",
      "claude:opus"
    ])
  })

  it("broadcasts each step's status LIVE, not just onto the stored plan", async () => {
    // `onStepDone` ticks the step on the persisted transcript, which is what
    // survives a crash — but a disk write says nothing to a running renderer.
    // Without `PlanUpdated` on the stream, every step of a live Gigaplan run
    // stayed on "proposed" in the Plan tab until the operator reloaded.
    const { layer } = recording()
    const events = await execute(
      planOf([step({ id: "a", number: "01" }), step({ id: "b", number: "02" })]),
      layer
    )
    const statuses = events
      .filter((e): e is Extract<StreamEvent, { _tag: "PlanUpdated" }> => e._tag === "PlanUpdated")
      .map((e) => e.plan.steps.map((s) => `${s.number}:${s.status ?? "proposed"}`).join(" "))

    // Each step goes current before it runs and done once it settles, and the
    // earlier step's `done` persists into the later step's updates.
    expect(statuses).toStrictEqual([
      "01:current 02:proposed",
      "01:done 02:proposed",
      "01:done 02:current",
      "01:done 02:done"
    ])
  })

  it("runs every assigned step in auto when approval selected auto", async () => {
    const { ran, layer } = recording()
    await execute(planOf([step({ id: "a", number: "01" })]), layer, undefined, "auto")

    expect(ran.map((r) => r.mode)).toStrictEqual(["auto"])
  })

  it("runs steps in dependency order, not the order they were written", async () => {
    const { ran, layer } = recording()
    await execute(
      planOf([
        step({ id: "backfill", number: "01", dependsOn: ["02"] }),
        step({ id: "migrate", number: "02" })
      ]),
      layer
    )
    // The arrow marks THIS agent's step; the outline lists every step, so it
    // is the only discriminator in the prompt.
    expect(ran.map((r) => (r.prompt.includes("→ 02") ? "02" : "01"))).toStrictEqual(["02", "01"])
  })

  it("retries a step that failed, rather than abandoning the run", async () => {
    // The run is meant to carry an approved plan to completion unattended. Most
    // first failures are a missing detail the agent can work around once it
    // knows, so one bad attempt must not end the whole plan.
    let attempts = 0
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) => {
        attempts += 1
        return attempts === 1
          ? Effect.fail(new CliExecError({ kind: "spawn", message: "boom" }))
          : ctx.emit({ _tag: "Assistant", text: "ok", agentId: undefined })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([step({ id: "a", number: "01" })]), layer)
    expect(attempts).toBe(2)
    expect(events.find((e) => e._tag === "Failed")).toBeUndefined()
  })

  it("feeds the previous blocker into the retry", async () => {
    // Without it the agent repeats the same approach and fails the same way,
    // turning three attempts into one attempt billed three times.
    const prompts: Array<string> = []
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        prompts.push(spec.prompt)
        return ctx.emit({
          _tag: "Assistant",
          text:
            prompts.length === 1
              ? '```json\n{"status":"blocked","reason":"the migrations table is locked"}\n```'
              : '```json\n{"status":"done"}\n```',
          agentId: undefined
        })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    await execute(planOf([step({ id: "a", number: "01" })]), layer)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toMatch(/migrations table is locked/)
    expect(prompts[1]).toMatch(/migrations table is locked/)
    expect(prompts[1]).toMatch(/inspect the current worktree and tests/i)
  })

  it("falls back after a transient provider failure before mutation", async () => {
    const ran: Array<string> = []
    const persisted: Array<PlanStep> = []
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: [{ cli: "claude", model: "opus" }]
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        ran.push(`${spec.cli}/${spec.model}`)
        return spec.cli === "codex"
          ? ctx.emit({ _tag: "Failed", message: "provider temporarily unavailable" })
          : ctx.emit({ _tag: "Assistant", text: "done", agentId: undefined })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await Effect.gen(function* () {
      const executor = yield* PlanExecutor
      return yield* executor
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan: planOf([routed]),
          available: [
            { cli: "codex", model: "gpt-5.6-sol" },
            { cli: "claude", model: "opus" }
          ],
          fallback: null,
          binPathFor: () => null,
          onStepUpdated: (updated) => Effect.sync(() => persisted.push(updated))
        })
        .pipe(Stream.runCollect, Effect.map((chunk) => [...chunk]))
    }).pipe(Effect.provide(PlanExecutor.Default), Effect.provide(layer), Effect.runPromise)

    expect(ran).toStrictEqual(["codex/gpt-5.6-sol", "claude/opus"])
    expect(events.find((event) => event._tag === "Failed")).toBeUndefined()
    expect(persisted.at(-1)?.routing?.attempts.map((attempt) => attempt.outcome)).toStrictEqual([
      "failed",
      "done"
    ])
  })

  it("retries the same route when a transient failure has no alternative", async () => {
    const ran: Array<string> = []
    const prompts: Array<string> = []
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: []
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        ran.push(`${spec.cli}/${spec.model}`)
        prompts.push(spec.prompt)
        return ran.length === 1
          ? ctx.emit({ _tag: "Failed", message: "429 rate limit exceeded" })
          : ctx.emit({ _tag: "Assistant", text: "done", agentId: undefined })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([routed]), layer, [
      { cli: "codex", model: "gpt-5.6-sol" }
    ])
    expect(ran).toStrictEqual(["codex/gpt-5.6-sol", "codex/gpt-5.6-sol"])
    expect(prompts[1]).toMatch(/429 rate limit exceeded/)
    expect(prompts[1]).toMatch(/inspect the current worktree and tests/i)
    expect(events.find((event) => event._tag === "Failed")).toBeUndefined()
  })

  it("retries an unclassified execution failure on the same route", async () => {
    let attempts = 0
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: []
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) => {
        attempts += 1
        return attempts === 1
          ? Effect.fail(new CliExecError({ kind: "codex", message: "unexpected protocol frame" }))
          : ctx.emit({ _tag: "Assistant", text: "done", agentId: undefined })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([routed]), layer, [
      { cli: "codex", model: "gpt-5.6-sol" }
    ])
    expect(attempts).toBe(2)
    expect(events.find((event) => event._tag === "Failed")).toBeUndefined()
  })

  it("retries the same route rather than falling back after mutation", async () => {
    const ran: Array<string> = []
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "high",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "schema profile",
          alternatives: [{ cli: "claude", model: "opus" }]
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) =>
        Effect.gen(function* () {
          ran.push(`${spec.cli}/${spec.model}`)
          if (ran.length === 1) {
            yield* ctx.emit({
              _tag: "ToolStart",
              id: "edit-1",
              name: "Edit",
              target: "src/a.ts"
            })
            yield* ctx.emit({ _tag: "Failed", message: "provider temporarily unavailable" })
          } else {
            yield* ctx.emit({ _tag: "Assistant", text: "done", agentId: undefined })
          }
        }),
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([routed]), layer)
    expect(ran).toStrictEqual(["codex/gpt-5.6-sol", "codex/gpt-5.6-sol"])
    expect(events.find((event) => event._tag === "Failed")).toBeUndefined()
    expect(
      events.some(
        (event) =>
          event._tag === "Assistant" && /retrying the same route instead of falling back/i.test(event.text)
      )
    ).toBe(true)
  })

  it("keeps shadow failures on the legacy route even if old metadata has alternatives", async () => {
    const ran: Array<string> = []
    const routed = step({
      id: "a",
      number: "01",
      assignee: { cli: "codex", model: "gpt-5.6-sol", reason: "planner choice" },
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "shadow",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "planner-preference",
          reason: "planner choice",
          alternatives: [{ cli: "claude", model: "opus" }]
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        ran.push(`${spec.cli}/${spec.model}`)
        return ran.length === 1
          ? ctx.emit({ _tag: "Failed", message: "provider temporarily unavailable" })
          : ctx.emit({ _tag: "Assistant", text: "done", agentId: undefined })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([routed]), layer)
    expect(ran).toStrictEqual(["codex/gpt-5.6-sol", "codex/gpt-5.6-sol"])
    expect(events.find((event) => event._tag === "Failed")).toBeUndefined()
  })

  it("does not fall back for credentials or permission failures", async () => {
    const ran: Array<string> = []
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: [{ cli: "claude", model: "opus" }]
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        ran.push(`${spec.cli}/${spec.model}`)
        return ctx.emit({ _tag: "Failed", message: "permission denied: missing API key" })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([routed]), layer)
    expect(ran).toStrictEqual(["codex/gpt-5.6-sol"])
    const failed = events.find((event) => event._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/permission denied/)
  })

  it("shares the three-run budget across fallback and same-route blockers", async () => {
    let attempts = 0
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: [{ cli: "claude", model: "opus" }]
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        attempts += 1
        return spec.cli === "codex"
          ? ctx.emit({ _tag: "Failed", message: "provider overloaded" })
          : ctx.emit({
              _tag: "Assistant",
              text: '```json\n{"status":"blocked","reason":"test lock"}\n```',
              agentId: undefined
            })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(planOf([routed]), layer)
    expect(attempts).toBe(MAX_STEP_ATTEMPTS)
    const failed = events.find((event) => event._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/Stuck on step 01/)
  })

  it("stops and says it is stuck once the attempts run out", async () => {
    // The ONE thing that stops an approved plan. An agent that has failed three
    // times with three explanations is not one attempt from success, and
    // pressing on into steps that depended on this one is what the adversarial
    // round exists to prevent.
    let attempts = 0
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) => {
        attempts += 1
        return ctx.emit({
          _tag: "Assistant",
          text: '```json\n{"status":"blocked","reason":"needs a decision only you can make"}\n```',
          agentId: undefined
        })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(
      planOf([step({ id: "a", number: "01" }), step({ id: "b", number: "02" })]),
      layer
    )
    expect(attempts).toBe(MAX_STEP_ATTEMPTS)
    const failed = events.find((e) => e._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/Stuck on step 01/)
    // And it names the blocker, so the operator knows what to decide.
    expect(failed?._tag === "Failed" && failed.message).toMatch(/only you can make/)
  })

  it("says what it is NOT running, rather than quietly omitting it", async () => {
    // Discovering a skipped branch only from a diff that is missing work is far
    // worse than being told up front.
    const { layer } = recording()
    const events = await execute(
      planOf([
        step({ id: "a", number: "01" }),
        step({ id: "b", number: "02", kind: "branch", condition: "expired?" })
      ]),
      layer
    )
    const said = events
      .filter((e): e is Extract<StreamEvent, { _tag: "Assistant" }> => e._tag === "Assistant")
      .map((e) => e.text)
      .join("\n")
    expect(said).toMatch(/Skipping step 02/)
    expect(said).toMatch(/your call/)
  })

  it("fails rather than guessing when no installed harness can run a step", async () => {
    const { layer } = recording()
    const events = await Effect.gen(function* () {
      const svc = yield* PlanExecutor
      return yield* svc
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan: planOf([step({ id: "a", number: "01" })]),
          available: [],
          fallback: null,
          binPathFor: () => null
        })
        .pipe(
          Stream.runCollect,
          Effect.map((c) => [...c])
        )
    }).pipe(Effect.provide(PlanExecutor.Default), Effect.provide(layer), Effect.runPromise)

    const failed = events.find((e) => e._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/No installed harness/)
  })

  it("reports and persists a quota limit instead of calling it catalogue drift", async () => {
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: []
        },
        rejected: [],
        attempts: []
      }
    })
    const updates: Array<PlanStep> = []
    const { ran, layer } = recording()
    const events = await Effect.gen(function* () {
      const svc = yield* PlanExecutor
      return yield* svc
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan: planOf([routed]),
          available: [],
          unavailable: [
            {
              cli: "codex",
              model: "gpt-5.6-sol",
              reason: "quota limited until 2026-07-23T00:00:00.000Z"
            }
          ],
          fallback: null,
          binPathFor: () => null,
          onStepUpdated: (updated) => Effect.sync(() => updates.push(updated))
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk])
        )
    }).pipe(Effect.provide(PlanExecutor.Default), Effect.provide(layer), Effect.runPromise)

    expect(ran).toStrictEqual([])
    expect(updates.at(-1)?.routing?.attempts.at(-1)?.reason).toBe(
      "quota limited until 2026-07-23T00:00:00.000Z"
    )
    const said = events
      .filter((event): event is Extract<StreamEvent, { _tag: "Assistant" }> =>
        event._tag === "Assistant"
      )
      .map((event) => event.text)
      .join("\n")
    expect(said).toContain("quota limited until 2026-07-23T00:00:00.000Z")
    const failed = events.find((event) => event._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toContain(
      "quota limited until 2026-07-23T00:00:00.000Z"
    )
  })

  it("keeps unavailable route checks separate from real attempt numbers", async () => {
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "medium",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: [
            { cli: "claude", model: "opus" },
            { cli: "opencode", model: "qwen3-coder" }
          ]
        },
        rejected: [],
        attempts: []
      }
    })
    const updates: Array<PlanStep> = []
    const { ran, layer } = recording()

    await Effect.gen(function* () {
      const executor = yield* PlanExecutor
      yield* executor
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan: planOf([routed]),
          available: [{ cli: "opencode", model: "qwen3-coder" }],
          unavailable: [
            { cli: "codex", model: "gpt-5.6-sol", reason: "quota limited" },
            { cli: "claude", model: "opus", reason: "not installed" }
          ],
          fallback: null,
          binPathFor: () => null,
          onStepUpdated: (updated) => Effect.sync(() => updates.push(updated))
        })
        .pipe(Stream.runDrain)
    }).pipe(Effect.provide(PlanExecutor.Default), Effect.provide(layer), Effect.runPromise)

    expect(ran.map((run) => `${run.cli}/${run.model}`)).toStrictEqual([
      "opencode/qwen3-coder"
    ])
    expect(
      updates.at(-1)?.routing?.attempts.map(({ attempt, outcome }) => ({ attempt, outcome }))
    ).toStrictEqual([
      { attempt: null, outcome: "unavailable" },
      { attempt: null, outcome: "unavailable" },
      { attempt: 1, outcome: "done" }
    ])
  })

  it("retries a timed-out routed step on the same route after possible mutation", async () => {
    // A run that never ends leaves the session at "Idle" with no explanation —
    // the exact failure the planning round shipped with. A stall is treated as
    // a blocker, so it is retried like any other; the clock is advanced once per
    // attempt.
    let attempts = 0
    const routed = step({
      id: "a",
      number: "01",
      routing: {
        effort: "standard",
        risk: "high",
        policyVersion: "test-v1",
        mode: "active",
        decision: {
          cli: "codex",
          model: "gpt-5.6-sol",
          provenance: "policy-profile",
          reason: "backend profile",
          alternatives: [{ cli: "claude", model: "opus" }]
        },
        rejected: [],
        attempts: []
      }
    })
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) =>
        Effect.gen(function* () {
          attempts += 1
          yield* ctx.emit({ _tag: "ToolStart", id: "edit-1", name: "Edit", target: "src/a.ts" })
          return yield* Effect.never
        }),
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await Effect.gen(function* () {
      const svc = yield* PlanExecutor
      const fiber = yield* Effect.fork(
        svc
          .run({
            sessionId: "s1",
            repo: "widget",
            branch: "b",
            cwd: "/tmp/wt",
            plan: planOf([routed]),
            available: [
              { cli: "codex", model: "gpt-5.6-sol" },
              { cli: "claude", model: "opus" }
            ],
            fallback: null,
            binPathFor: () => null
          })
          .pipe(
            Stream.runCollect,
            Effect.map((c) => [...c])
          )
      )
      for (let i = 0; i < MAX_STEP_ATTEMPTS; i++) {
        yield* Effect.yieldNow()
        yield* TestClock.adjust("31 minutes")
      }
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(PlanExecutor.Default),
      Effect.provide(layer),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise
    )

    const failed = events.find((e) => e._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/Stuck on step 01/)
    expect(failed?._tag === "Failed" && failed.message).toMatch(/timed out after 30 minutes/)
    expect(attempts).toBe(MAX_STEP_ATTEMPTS)
    expect(STEP_TIMEOUT).toBe("30 minutes")
  })

  it("gives each step its own context rather than resuming the last one", async () => {
    // Steps may run on different models; resuming would carry one step's framing
    // into the next and defeat the point of assigning them separately.
    let seen: {
      fresh?: boolean
      resumeId: string | null
      readOnly?: boolean
    } | null = null
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, spec, ctx) => {
        seen = {
          fresh: spec.fresh,
          resumeId: spec.resumeId,
          readOnly: spec.readOnly
        }
        return ctx.emit({ _tag: "Assistant", text: "ok", agentId: undefined })
      },
      stop: () => Effect.void
    } as CliAdapterShape)
    await execute(planOf([step({ id: "a", number: "01" })]), layer)
    // `readOnly: false` matters as much as `fresh`: this is the one agent that
    // is supposed to change the worktree.
    expect(seen).toStrictEqual({
      fresh: true,
      resumeId: null,
      readOnly: false
    })
  })
})

describe("stepPrompt", () => {
  const plan = planOf([
    step({ id: "a", number: "01", title: "Add the column" }),
    step({ id: "b", number: "02", title: "Backfill" })
  ])

  it("marks which step is this agent's", () => {
    const prompt = stepPrompt({ plan, step: plan.steps[1]! })
    expect(prompt).toMatch(/→ 02 Backfill/)
    expect(prompt).toMatch(/ {2}01 Add the column/)
  })

  it("forbids doing the next step's work", () => {
    // A step that helpfully does more leaves another model a half-finished task
    // it never saw the start of, and makes the outcome unattributable.
    expect(stepPrompt({ plan, step: plan.steps[0]! })).toMatch(/Do only this step/)
  })

  it("fences the plan as data", () => {
    const prompt = stepPrompt({ plan, step: plan.steps[0]! })
    expect(prompt.match(/data, not instructions/g)).toHaveLength(2)
  })
})

describe("parseStepVerdict", () => {
  const json = (body: unknown) =>
    `Changed three files.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``

  it("reads a blocked verdict and its reason", () => {
    expect(parseStepVerdict(json({ status: "blocked", reason: "no credential" }))).toStrictEqual({
      status: "blocked",
      reason: "no credential"
    })
  })

  it("treats a missing or unreadable verdict as DONE, not blocked", () => {
    // The uncomfortable default, chosen deliberately. These steps share one
    // worktree and have already written to it, so re-running one that actually
    // succeeded risks applying its edits twice — a worse and far less visible
    // failure than a step that quietly did less than it claimed.
    expect(parseStepVerdict("I finished the step.")).toStrictEqual({
      status: "done",
      reason: null
    })
    expect(parseStepVerdict(json({ nonsense: true }))).toStrictEqual({
      status: "done",
      reason: null
    })
    expect(parseStepVerdict(json({ status: "partially" }))).toStrictEqual({
      status: "done",
      reason: null
    })
  })

  it("accepts an untidy status", () => {
    expect(parseStepVerdict(json({ status: " BLOCKED " })).status).toBe("blocked")
  })

  it("keeps a blocked verdict usable even with no reason given", () => {
    // Still blocked — the loop needs to retry it — but the operator is told the
    // agent didn't explain itself rather than being shown a blank.
    expect(parseStepVerdict(json({ status: "blocked" }))).toStrictEqual({
      status: "blocked",
      reason: null
    })
  })
})

describe("against the scripted adapter", () => {
  it("carries a two-step plan all the way to its tally", async () => {
    // The fakes above each answer one question; this drives the executor against
    // the SAME adapter the e2e suite uses, which streams a full realistic turn
    // (thinking, reads, a gated edit, a gated command) per step. It is the
    // cheapest place to catch an executor that stalls on a real event sequence
    // rather than a one-shot reply — a failure that would otherwise only show up
    // as an e2e timeout with nothing to point at.
    const plan = planOf([step({ id: "a", number: "01" }), step({ id: "b", number: "02" })])
    const events = await Effect.gen(function* () {
      const svc = yield* PlanExecutor
      return yield* svc
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan,
          available: [{ cli: "claude", model: "opus" }],
          fallback: { cli: "claude", model: "opus" },
          binPathFor: () => null
        })
        .pipe(
          Stream.runCollect,
          Effect.map((c) => [...c])
        )
    }).pipe(
      Effect.provide(PlanExecutor.Default),
      // Zero pacing: the cadence is the e2e's concern, not this test's.
      Effect.provide(makeScriptedCliAdapter(0)),
      Effect.runPromise
    )

    const said = events
      .filter((e): e is Extract<StreamEvent, { _tag: "Assistant" }> => e._tag === "Assistant")
      .map((e) => e.text)
      .join("\n")
    expect(said).toMatch(/Ran 2 of 2 steps/)
    expect(events.find((e) => e._tag === "Failed")).toBeUndefined()
  })
})

describe("a child run's lifecycle events", () => {
  it("never reach the parent stream, or the first step ends the whole run", async () => {
    // The bug this exists for, measured in the real app: each step's adapter
    // emits its own `Done`, which carries no `agentId` and so cannot be scoped
    // to a subagent. The renderer treats ANY `Done` as the turn finishing, tore
    // down the stream actor and interrupted the fiber — killing the executor
    // midway through step 2. Exactly one `Done` may cross this boundary: the
    // executor's own, at the end.
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit({
            _tag: "Started",
            sessionId: "child",
            model: undefined
          })
          yield* ctx.emit({
            _tag: "Assistant",
            text: "did it",
            agentId: undefined
          })
          yield* ctx.emit({ _tag: "Done", costUsd: 1, tokens: 2 })
        }),
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await execute(
      planOf([step({ id: "a", number: "01" }), step({ id: "b", number: "02" })]),
      layer
    )

    expect(events.filter((e) => e._tag === "Done")).toHaveLength(1)
    // And it is the LAST thing, after both steps — not step 1 cutting the run off.
    expect(events[events.length - 1]?._tag).toBe("Done")
    expect(events.filter((e) => e._tag === "Started")).toHaveLength(1)
    const said = events
      .filter((e): e is Extract<StreamEvent, { _tag: "Assistant" }> => e._tag === "Assistant")
      .map((e) => e.text)
      .join("\n")
    expect(said).toMatch(/Ran 2 of 2 steps/)
  })

  it("treats a child Failed event as a failed attempt, never an empty done verdict", async () => {
    let attempts = 0
    const completed: Array<string> = []
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) => {
        attempts += 1
        return ctx.emit({ _tag: "Failed", message: "provider unavailable" })
      },
      stop: () => Effect.void
    } as CliAdapterShape)

    const events = await Effect.gen(function* () {
      const executor = yield* PlanExecutor
      return yield* executor
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan: planOf([step({ id: "a", number: "01" })]),
          available: [{ cli: "claude", model: "opus" }],
          fallback: { cli: "claude", model: "opus" },
          binPathFor: () => null,
          onStepDone: (finished) => Effect.sync(() => completed.push(finished.id))
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk])
        )
    }).pipe(Effect.provide(PlanExecutor.Default), Effect.provide(layer), Effect.runPromise)

    expect(attempts).toBe(MAX_STEP_ATTEMPTS)
    expect(completed).toStrictEqual([])
    const failed = events.find((event) => event._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/provider unavailable/)
  })
})

describe("what the run reports it spent", () => {
  it("sums the steps' spend instead of reporting zero", async () => {
    // A step's `Done` is dropped as a child lifecycle event, but it is the only
    // carrier of cost. Dropping it outright meant a twelve-step run on a
    // flagship model reported a spend of exactly 0 — in a feature whose sibling
    // machinery (subscription.ts, addUsage) exists because silent spend is the
    // failure being fixed.
    const layer: Layer.Layer<CliAdapter> = Layer.succeed(CliAdapter, {
      run: (_id, _spec, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit({
            _tag: "Assistant",
            text: "done",
            agentId: undefined
          })
          yield* ctx.emit({ _tag: "Done", costUsd: 0.25, tokens: 1_000 })
        }),
      stop: () => Effect.void
    } as CliAdapterShape)

    const plan = planOf([step({ id: "s_01", number: "01" }), step({ id: "s_02", number: "02" })])
    const events: Array<StreamEvent> = []
    await Effect.gen(function* () {
      const executor = yield* PlanExecutor
      yield* executor
        .run({
          sessionId: "s1",
          repo: "widget",
          branch: "b",
          cwd: "/tmp/wt",
          plan,
          available: [{ cli: "claude" as const, model: "opus" }],
          fallback: { cli: "claude" as const, model: "opus" },
          binPathFor: () => null
        })
        .pipe(Stream.runForEach((e) => Effect.sync(() => events.push(e))))
    }).pipe(Effect.provide(Layer.mergeAll(PlanExecutor.Default, layer)), Effect.runPromise)

    const done = events.find((e) => e._tag === "Done")
    expect(done).toBeDefined()
    if (done?._tag === "Done") {
      expect(done.costUsd).toBeCloseTo(0.5, 5)
      expect(done.tokens).toBe(2_000)
    }
  })
})
