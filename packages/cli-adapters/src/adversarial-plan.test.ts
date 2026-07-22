import type { Plan, RoutingContext, StreamEvent, VendorReach } from "@starbase/core"
import { CliExecError, GIGAPLAN_ROUTING_POLICY_VERSION } from "@starbase/core"
import { Effect, Fiber, Layer, Stream, TestClock, TestContext } from "effect"
import { describe, expect, it } from "vitest"
import type { ParsedCritique } from "./adversarial-plan.js"
import { CliAdapter } from "./adapter.js"
import {
  AdversarialPlanService,
  applyChallenges,
  chooseRoles,
  flagshipFor,
  markUnchallenged,
  parseCritique,
  parseResponses,
  unattendedAnswers
} from "./adversarial-plan.js"
import { formatQuestionAnswer } from "./claude-adapter.js"
import { parsePlan } from "./plan-parse.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLAN_TEXT = [
  "```plan",
  "summary: Add a tier column",
  "01 Add the column",
  "  intent: Accounts need a tier.",
  "  task: schema",
  "02 Backfill",
  "  intent: Existing rows need values.",
  "  task: backend",
  "```"
].join("\n")

const critiqueJson = (challenges: ReadonlyArray<unknown>): string =>
  `Here is my review.\n\n\`\`\`json\n${JSON.stringify({ challenges })}\n\`\`\``

const responseJson = (responses: ReadonlyArray<unknown>): string =>
  `${PLAN_TEXT}\n\n\`\`\`json\n${JSON.stringify({ responses })}\n\`\`\``

const reach = (vendor: string, cli: VendorReach["cli"], ...ids: string[]): VendorReach => ({
  vendor,
  cli,
  models: ids.map((id) => ({ id, label: id }))
})

const ANTHROPIC = reach("anthropic", "claude", "opus", "claude-fable-5")
const OPENAI = reach("openai", "codex", "gpt-5.6-sol")
const MOONSHOT = reach("moonshot", "opencode", "openrouter/moonshot/kimi-k3")

const routingFor = (vendors: ReadonlyArray<VendorReach>): RoutingContext => ({
  catalog: vendors.map((vendor) => ({
    cli: vendor.cli,
    label: vendor.vendor,
    models: vendor.models
  })),
  mode: "shadow",
  affinityEnabled: false
})

/**
 * A fake adapter that replies with canned text per role, so the whole round runs
 * without a harness. Keyed by role because the same session drives three runs.
 */
const fakeAdapter = (
  replies: Partial<
    Record<"propose" | "attack" | "revise", string | CliExecError | { readonly failure: string }>
  >
): Layer.Layer<CliAdapter> =>
  Layer.succeed(CliAdapter, {
    run: (sessionId, _spec, ctx) => {
      const role = sessionId.startsWith("plan_propose")
        ? "propose"
        : sessionId.startsWith("plan_attack")
          ? "attack"
          : "revise"
      const reply = replies[role]
      if (reply === undefined) return Effect.void
      if (reply instanceof CliExecError) return Effect.fail(reply)
      if (typeof reply !== "string") return ctx.emit({ _tag: "Failed", message: reply.failure })
      return ctx.emit({ _tag: "Assistant", text: reply, agentId: undefined })
    },
    stop: () => Effect.void
  })

const runRound = (
  replies: Parameters<typeof fakeAdapter>[0],
  vendors: ReadonlyArray<VendorReach> = [ANTHROPIC, OPENAI]
): Promise<{ events: ReadonlyArray<StreamEvent>; plan: Plan | null }> =>
  Effect.gen(function* () {
    const svc = yield* AdversarialPlanService
    const events = yield* svc
      .run({
        sessionId: "s1",
        repo: "acme/api",
        branch: "starbase/x",
        cwd: "/tmp/wt",
        brief: "Add a tier column",
        vendors,
        binPathFor: () => "/usr/bin/fake",
        assignAgents: false,
        routing: routingFor(vendors)
      })
      .pipe(Stream.runCollect, Effect.map((c) => [...c]))
    const proposed = events.find((e) => e._tag === "PlanProposed")
    return { events, plan: proposed?._tag === "PlanProposed" ? proposed.plan : null }
  }).pipe(
    Effect.provide(AdversarialPlanService.Default),
    Effect.provide(fakeAdapter(replies)),
    Effect.runPromise
  )

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("parseCritique", () => {
  it("distinguishes 'found nothing' from 'said nothing parseable'", () => {
    // The distinction the whole feature rests on: an empty array means a rival
    // lab read the plan and was satisfied; null means nobody meaningfully
    // reviewed it, and reporting that as clean would be the worst thing we
    // could do.
    expect(parseCritique(critiqueJson([]))?.challenges).toEqual([])
    expect(parseCritique("I'd rather not review this.")).toBeNull()
  })

  it("normalises step references models write inconsistently", () => {
    const parsed = parseCritique(
      critiqueJson([
        { step: "2", title: "a" },
        { step: "step 03", title: "b" },
        { step: null, title: "c" }
      ])
    )
    expect(parsed?.targets).toEqual(["02", "03", null])
  })

  it("drops a challenge with no title and folds an unknown severity", () => {
    const parsed = parseCritique(
      critiqueJson([{ title: "", rationale: "x" }, { title: "real", severity: "catastrophic" }])
    )
    expect(parsed?.challenges).toHaveLength(1)
    expect(parsed?.challenges[0]?.severity).toBe("minor")
  })
})

describe("parseResponses", () => {
  it("refuses a defence with no reason", () => {
    // "I considered this and disagree", with no argument, is indistinguishable
    // from ignoring it — trusting it would let a model dismiss every objection.
    const r = parseResponses(responseJson([{ id: "c1", status: "defended", defence: null }]))
    expect(r.get("c1")).toBeUndefined()
  })

  it("accepts an addressed response and a reasoned defence", () => {
    const r = parseResponses(
      responseJson([
        { id: "c1", status: "addressed" },
        { id: "c2", status: "defended", defence: "The migration is idempotent." }
      ])
    )
    expect(r.get("c1")?.status).toBe("addressed")
    expect(r.get("c2")?.defence).toBe("The migration is idempotent.")
  })

  it("is empty rather than throwing on junk", () => {
    expect(parseResponses("no json here").size).toBe(0)
  })
})

describe("applyChallenges", () => {
  const plan = parsePlan(PLAN_TEXT, "p1")
  const critique = parseCritique(
    critiqueJson([
      { step: "01", title: "ordering", severity: "major" },
      { step: "02", title: "untested", severity: "minor" }
    ])
  )!

  it("leaves an unanswered challenge open", () => {
    // Silence is not resolution — this is the point of the whole round.
    const out = applyChallenges(plan, critique, new Map())
    expect(out.steps[0]!.challenges?.[0]?.status).toBe("open")
  })

  it("records addressed and defended answers on the right steps", () => {
    const out = applyChallenges(
      plan,
      critique,
      new Map([
        ["c1", { status: "addressed" as const, defence: null }],
        ["c2", { status: "defended" as const, defence: "Covered by the e2e suite." }]
      ])
    )
    expect(out.steps[0]!.challenges?.[0]?.status).toBe("addressed")
    expect(out.steps[1]!.challenges?.[0]?.defence).toBe("Covered by the e2e suite.")
  })

  it("marks an unchallenged step as examined, not unexamined", () => {
    const out = applyChallenges(plan, { challenges: [], targets: [] }, new Map())
    expect(out.steps[0]!.challenges).toEqual([])
    expect(markUnchallenged(plan).steps[1]!.challenges).toEqual([])
  })

  it("follows the step through a renumbering revision", () => {
    // The revision inserts a step, so the challenged step slides 03 -> 04.
    // Keying by number pinned the challenge to whatever now sits at 03 and gave
    // the real step `[]` — "examined and survived" — which is the exact
    // inversion of what the adversary said.
    const proposal = {
      steps: [
        { id: "a", number: "01", title: "Add the column" },
        { id: "b", number: "02", title: "Backfill from billing" },
        { id: "c", number: "03", title: "Drop the old table" }
      ]
    } as unknown as Plan
    const revised = {
      steps: [
        { id: "a", number: "01", title: "Add the column" },
        { id: "x", number: "02", title: "Take a snapshot" },
        { id: "b", number: "03", title: "Backfill from billing" },
        { id: "c", number: "04", title: "Drop the old table" }
      ]
    } as unknown as Plan
    const critique = {
      challenges: [
        { id: "c1", severity: "critical", title: "No rollback", rationale: "r", status: "open" }
      ],
      targets: ["03"]
    } as unknown as ParsedCritique

    const out = applyChallenges(revised, critique, new Map(), proposal)
    const byTitle = new Map(out.steps.map((s) => [s.title, s.challenges]))

    // The challenge follows the WORK, not the ordinal.
    expect(byTitle.get("Drop the old table")).toHaveLength(1)
    expect(byTitle.get("Backfill from billing")).toStrictEqual([])
  })

  it("never reports a step the adversary never saw as examined-and-clean", () => {
    // A step the revision invented was reviewed by nobody. `[]` would claim it
    // survived scrutiny; absent is the honest answer, and `wasChallenged`
    // depends on the distinction.
    const proposal = {
      steps: [{ id: "a", number: "01", title: "Add the column" }]
    } as unknown as Plan
    const revised = {
      steps: [
        { id: "a", number: "01", title: "Add the column" },
        { id: "x", number: "02", title: "Take a snapshot" }
      ]
    } as unknown as Plan

    const out = applyChallenges(
      revised,
      { challenges: [], targets: [] } as unknown as ParsedCritique,
      new Map(),
      proposal
    )
    expect(out.steps[0]!.challenges).toStrictEqual([])
    expect(out.steps[1]!.challenges).toBeUndefined()
  })
})

describe("chooseRoles", () => {
  it("needs two labs", () => {
    expect(chooseRoles([ANTHROPIC])).toBeNull()
    expect(chooseRoles([])).toBeNull()
  })

  it("never pairs a lab against itself", () => {
    const roles = chooseRoles([ANTHROPIC, OPENAI, MOONSHOT])!
    expect(roles.proposer.vendor).not.toBe(roles.adversary.vendor)
  })

  it("prefers Anthropic proposing and OpenAI attacking when both are present", () => {
    const roles = chooseRoles([MOONSHOT, OPENAI, ANTHROPIC])!
    expect(roles.proposer.vendor).toBe("anthropic")
    expect(roles.adversary.vendor).toBe("openai")
  })

  it("falls back to stable order so roles never flicker", () => {
    const roles = chooseRoles([MOONSHOT, reach("deepseek", "opencode", "x/deepseek/v4")])!
    expect(roles.proposer.vendor).toBe("moonshot")
    expect(roles.adversary.vendor).toBe("deepseek")
  })
})

describe("flagshipFor", () => {
  it("takes the harness's curated top tier when it belongs to this vendor", () => {
    expect(flagshipFor(ANTHROPIC)?.id).toBe("claude-fable-5")
  })

  it("takes the vendor's own model when the curated default is another vendor's", () => {
    // opencode's curated default is an opencode model; a Moonshot round must
    // not run on it.
    expect(flagshipFor(MOONSHOT)?.id).toBe("openrouter/moonshot/kimi-k3")
  })

  it("is null for a vendor with no models", () => {
    expect(flagshipFor(reach("empty", "opencode"))).toBeNull()
  })
})

// ── The round ────────────────────────────────────────────────────────────────

describe("AdversarialPlanService", () => {
  it("proposes, attacks and revises", async () => {
    const { plan, events } = await runRound({
      propose: PLAN_TEXT,
      attack: critiqueJson([{ step: "01", title: "ordering", severity: "major" }]),
      revise: responseJson([{ id: "c1", status: "addressed" }])
    })
    expect(plan?.steps[0]!.challenges?.[0]?.status).toBe("addressed")
    expect(plan?.steps[0]!.routing).toMatchObject({
      effort: "standard",
      risk: "medium",
      policyVersion: GIGAPLAN_ROUTING_POLICY_VERSION
    })
    // Each phase is surfaced as a subagent, so the existing tab UI renders it.
    const started = events.filter((e) => e._tag === "SubagentStarted")
    expect(started).toHaveLength(3)
  })

  it("resolves the revision again instead of inheriting the proposal route", async () => {
    const revised = [
      "```plan",
      "summary: Add a frontend tier badge",
      "01 Add the badge",
      "  intent: Show the tier.",
      "  task: frontend",
      "  effort: quick",
      "  risk: low",
      "```",
      "",
      "```json",
      JSON.stringify({ responses: [{ id: "c1", status: "addressed" }] }),
      "```"
    ].join("\n")
    const { plan } = await runRound({
      propose: PLAN_TEXT,
      attack: critiqueJson([{ step: "01", title: "wrong surface", severity: "major" }]),
      revise: revised
    })

    expect(plan?.steps[0]).toMatchObject({ taskKind: "frontend", effort: "quick", risk: "low" })
    expect(plan?.steps[0]?.routing?.shadowDecision?.cli).toBe("claude")
  })

  it("degrades to an unchallenged plan when the adversary dies", async () => {
    const { plan } = await runRound({
      propose: PLAN_TEXT,
      attack: new CliExecError({ kind: "spawn", message: "boom" })
    })
    // Still a plan — but every step is left UNEXAMINED, not marked clean.
    expect(plan?.steps).toHaveLength(2)
    expect(plan?.steps[0]!.challenges).toBeUndefined()
  })

  it("surfaces the proposer harness's actionable failure", async () => {
    const { events } = await runRound({
      propose: new CliExecError({
        kind: "claude",
        message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
      })
    })

    expect(events).toContainEqual({
      _tag: "Failed",
      message:
        "The Proposing step failed: Claude authentication failed. Run `claude auth login` in a terminal, then try again."
    })
  })

  it("does not swallow a failed lifecycle event from a Gigaplan role", async () => {
    const { events } = await runRound({
      propose: {
        failure: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
      }
    })

    expect(events).toContainEqual({
      _tag: "Failed",
      message:
        "The Proposing step failed: Claude authentication failed. Run `claude auth login` in a terminal, then try again."
    })
  })

  it("does not present an unparseable critique as a clean bill of health", async () => {
    const { plan } = await runRound({
      propose: PLAN_TEXT,
      attack: "I'd rather not review this."
    })
    expect(plan?.steps[0]!.challenges).toBeUndefined()
  })

  it("marks steps examined when the adversary genuinely found nothing", async () => {
    const { plan } = await runRound({ propose: PLAN_TEXT, attack: critiqueJson([]) })
    expect(plan?.steps[0]!.challenges).toEqual([])
  })

  it("keeps challenges open when the revision never comes", async () => {
    const { plan } = await runRound({
      propose: PLAN_TEXT,
      attack: critiqueJson([{ step: "01", title: "ordering" }]),
      revise: new CliExecError({ kind: "spawn", message: "boom" })
    })
    expect(plan?.steps[0]!.challenges?.[0]?.status).toBe("open")
  })

  it("fails when only one lab is reachable", async () => {
    const { events } = await runRound({ propose: PLAN_TEXT }, [ANTHROPIC])
    const failed = events.find((e) => e._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/two model providers/)
  })

  it("attributes every step to the model that proposed it", async () => {
    const { plan } = await runRound({ propose: PLAN_TEXT, attack: critiqueJson([]) })
    expect(plan?.steps[0]!.origin).toStrictEqual({
      cli: "claude",
      model: "claude-fable-5",
      vendor: "anthropic"
    })
  })

  it("runs each role read-only and fresh", async () => {
    const specs: Array<{ readOnly?: boolean; fresh?: boolean; model: string | null }> = []
    await Effect.gen(function* () {
      const svc = yield* AdversarialPlanService
      yield* svc
        .run({
          sessionId: "s1",
          repo: "r",
          branch: "b",
          cwd: "/tmp",
          brief: "x",
          vendors: [ANTHROPIC, OPENAI],
          binPathFor: () => "/bin/fake",
          assignAgents: false,
          routing: routingFor([ANTHROPIC, OPENAI])
        })
        .pipe(Stream.runDrain)
    }).pipe(
      Effect.provide(AdversarialPlanService.Default),
      Effect.provide(
        Layer.succeed(CliAdapter, {
          run: (_id, spec, ctx) => {
            specs.push({ readOnly: spec.readOnly, fresh: spec.fresh, model: spec.model })
            return ctx.emit({ _tag: "Assistant", text: PLAN_TEXT, agentId: undefined })
          },
          stop: () => Effect.void
        })
      ),
      Effect.runPromise
    )
    // readOnly is the load-bearing half: Codex never calls canUseTool at all.
    // fresh matters because the adapter's resume map outranks the spec, so a
    // re-plan would otherwise inherit the previous round's context.
    expect(specs.every((s) => s.readOnly === true && s.fresh === true)).toBe(true)
    expect(specs[0]!.model).toBe("claude-fable-5")
    expect(specs[1]!.model).toBe("gpt-5.6-sol")
  })
})

// ── Unattended questions and the stall guard ─────────────────────────────────

describe("unattendedAnswers", () => {
  const questions = [
    { question: "Is `billingRows()` canonical?", header: "Source", options: [], multiSelect: false },
    { question: "What engine runs the migrations?", header: "Engine", options: [], multiSelect: false }
  ]

  it("answers every question, positionally", () => {
    // `formatQuestionAnswer` pairs answers to questions by index, so a short
    // array would silently render "(no selection)" for the tail.
    expect(unattendedAnswers(questions)).toHaveLength(2)
  })

  it("never renders as '(no selection)' — the exact text that caused the stall", () => {
    // The regression this whole change exists for, asserted against the REAL
    // formatter rather than a copy of its wording, so the two cannot drift.
    // Empty answers are what we used to send; they read as a non-answer, and the
    // model responds by rephrasing and asking again, forever.
    const broken = formatQuestionAnswer(questions, [])
    expect(broken).toContain("(no selection)")

    const fixed = formatQuestionAnswer(questions, unattendedAnswers(questions))
    expect(fixed).not.toContain("(no selection)")
    expect(fixed).toContain("record the choice explicitly as an assumption")
  })

  it("does not invent a preference among the options", () => {
    // Picking one for the model would silently steer the plan while looking like
    // the operator had chosen it.
    for (const a of unattendedAnswers(questions)) expect(a.selected).toStrictEqual([])
  })
})

describe("a role that never finishes", () => {
  it("fails the round with a timeout, rather than hanging forever", async () => {
    // What shipped: the proposer looped on AskUserQuestion, the round never
    // ended, and the session sat at "Idle" with nothing on screen to say it had
    // died. A bound turns that into a visible failure.
    const events = await Effect.gen(function* () {
      const svc = yield* AdversarialPlanService
      const fiber = yield* Effect.fork(
        svc
          .run({
            sessionId: "s1",
            repo: "acme/api",
            branch: "starbase/x",
            cwd: "/tmp/wt",
            brief: "Add a tier column",
            vendors: [ANTHROPIC, OPENAI],
            binPathFor: () => "/usr/bin/fake",
            assignAgents: false,
            routing: routingFor([ANTHROPIC, OPENAI])
          })
          .pipe(Stream.runCollect, Effect.map((c) => [...c]))
      )
      // Let the round reach the timeout before the virtual clock jumps past it.
      yield* Effect.yieldNow()
      yield* TestClock.adjust("10 minutes")
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(AdversarialPlanService.Default),
      Effect.provide(Layer.succeed(CliAdapter, { run: () => Effect.never, stop: () => Effect.void })),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise
    )

    const failed = events.find((e) => e._tag === "Failed")
    expect(failed?._tag === "Failed" && failed.message).toMatch(/gave up after/)
  })
})
