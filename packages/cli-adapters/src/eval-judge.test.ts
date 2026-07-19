import type { WorkspaceConfig } from "@starbase/core"
import { CliExecError, JUDGE_WEIGHT, withJudgement } from "@starbase/core"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { CliAdapter } from "./adapter.js"
import { dailyBudget, judge, judgeEnabled, parseVerdict } from "./eval-judge.js"
import { evalPrompt } from "./eval-prompt.js"

const verdictJson = (body: unknown) => `Thinking…\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``

const config = (over: Partial<NonNullable<WorkspaceConfig["learning"]>> = {}): WorkspaceConfig => ({
  reposDir: "/repos",
  createdAt: "2026-01-01T00:00:00.000Z",
  learning: { enabled: true, ...over }
})

describe("judgeEnabled — fail closed", () => {
  it("needs its own switch AND the master switch", () => {
    // This is the only part of the loop that SPENDS, so it carries the strictest
    // gate: a stale `evalJudge: true` must not survive learning being turned off.
    expect(judgeEnabled(config({ evalJudge: true }))).toBe(true)
    expect(judgeEnabled(config({ evalJudge: false }))).toBe(false)
    expect(judgeEnabled(config())).toBe(false)
    expect(judgeEnabled({ ...config(), learning: { enabled: false, evalJudge: true } })).toBe(false)
    expect(judgeEnabled(null)).toBe(false)
  })
})

describe("dailyBudget", () => {
  it("bounds the spend even when left on", () => {
    expect(dailyBudget(config({ evalJudgeDailyBudget: 5 }))).toBe(5)
    expect(dailyBudget(config())).toBeGreaterThan(0)
    // Zero is a legitimate choice — "on, but spend nothing today".
    expect(dailyBudget(config({ evalJudgeDailyBudget: 0 }))).toBe(0)
    // Nonsense falls back rather than disabling the cap.
    expect(dailyBudget(config({ evalJudgeDailyBudget: -3 }))).toBeGreaterThan(0)
  })
})

describe("parseVerdict", () => {
  it("reads a well-formed verdict", () => {
    expect(parseVerdict(verdictJson({ score: 0.7, reason: "Solid." }))).toStrictEqual({
      score: 0.7,
      reason: "Solid."
    })
  })

  it("treats an abstention as null, NOT as neutral", () => {
    // Coercing a refusal to 0.5 would drag every judged cell toward the middle
    // while looking exactly like a real measurement.
    expect(parseVerdict(verdictJson({ score: null, reason: "Diff too large." })).score).toBeNull()
  })

  it("treats an unparseable reply as an abstention", () => {
    expect(parseVerdict("I'd rather not.").score).toBeNull()
    expect(parseVerdict(verdictJson({ nonsense: true })).score).toBeNull()
  })

  it("rejects an out-of-range score rather than clamping it", () => {
    // A judge returning 7 has misunderstood the scale; rescuing its number would
    // invent an opinion it did not express.
    expect(parseVerdict(verdictJson({ score: 7 })).score).toBeNull()
    expect(parseVerdict(verdictJson({ score: -1 })).score).toBeNull()
    expect(parseVerdict(verdictJson({ score: Number.NaN })).score).toBeNull()
  })

  it("keeps the boundary values", () => {
    expect(parseVerdict(verdictJson({ score: 0 })).score).toBe(0)
    expect(parseVerdict(verdictJson({ score: 1 })).score).toBe(1)
  })
})

describe("withJudgement", () => {
  it("leaves a score untouched when the judge abstained", () => {
    // An absent judge must be exactly equivalent to no judge, not to a neutral
    // one.
    expect(withJudgement(2.5, null)).toBe(2.5)
    expect(withJudgement(-4, null)).toBe(-4)
  })

  it("moves a score without taking it over", () => {
    // Asserted as monotonic in the verdict rather than "above the base": at a
    // base equal to the adjustment ceiling the blend converges exactly, so
    // comparing against the base tests an accident of the numbers.
    const base = 1
    const harsh = withJudgement(base, 0)
    const kind = withJudgement(base, 1)
    expect(kind).toBeGreaterThan(withJudgement(base, 0.5))
    expect(withJudgement(base, 0.5)).toBeGreaterThan(harsh)
    // The judge is a minority share — the deterministic signals still dominate.
    expect(JUDGE_WEIGHT).toBeLessThan(0.5)
  })

  it("cannot flip the sign of a clear outcome", () => {
    // The guard that keeps the loop grounded in observable events: a single
    // model's taste must not overturn "merged, CI green, no findings".
    expect(withJudgement(6, 0)).toBeGreaterThan(0)
    expect(withJudgement(-6, 1)).toBeLessThan(0)
  })

  it("does nothing when the judge is ambivalent", () => {
    expect(withJudgement(4, 0.5)).toBeCloseTo(4 * (1 - JUDGE_WEIGHT), 10)
  })
})

describe("evalPrompt", () => {
  it("never reveals which model did the work", () => {
    // A judge that knew would make the knowledge base self-confirming: rank a
    // model highly, judge its work generously, rank it higher.
    const prompt = evalPrompt({ task: "Add a tier column", diff: "diff --git a b" })
    expect(prompt).not.toMatch(/claude|codex|opencode|gpt-|opus/i)
  })

  it("makes abstaining explicitly cheap", () => {
    const prompt = evalPrompt({ task: "t", diff: "d" })
    expect(prompt).toMatch(/null score/)
    expect(prompt).toMatch(/guessed score is worse/)
  })

  it("scores the work, not the style", () => {
    const prompt = evalPrompt({ task: "t", diff: "d" })
    expect(prompt).toMatch(/not the style/i)
    expect(prompt).toMatch(/out of scope/)
  })

  it("fences the task and the diff as data", () => {
    const prompt = evalPrompt({ task: "```t```", diff: "```d```" })
    expect(prompt.match(/data, not/g)).toHaveLength(2)
  })
})

describe("judge", () => {
  const run = (reply: string | CliExecError) =>
    Effect.runPromise(
      judge({
        sessionId: "s1",
        repo: "r",
        branch: "b",
        cwd: "/w",
        task: "Add a tier column",
        diff: "diff",
        cli: "claude",
        model: "haiku",
        binPath: "/bin/fake"
      }).pipe(
        Effect.provide(
          Layer.succeed(CliAdapter, {
            run: (_id, _spec, ctx) =>
              reply instanceof CliExecError
                ? Effect.fail(reply)
                : ctx.emit({ _tag: "Assistant", text: reply, agentId: undefined }),
            stop: () => Effect.void
          })
        )
      )
    )

  it("returns the parsed verdict", async () => {
    expect((await run(verdictJson({ score: 0.8, reason: "Good." }))).score).toBe(0.8)
  })

  it("treats a crashed judge as an ABSENT verdict, not a bad one", async () => {
    // "The judge crashed" is not "the work was bad".
    expect((await run(new CliExecError({ kind: "spawn", message: "boom" }))).score).toBeNull()
  })

  it("runs read-only and fresh", async () => {
    let seen: { readOnly?: boolean; fresh?: boolean; model: string | null } | null = null
    await Effect.runPromise(
      judge({
        sessionId: "s1",
        repo: "r",
        branch: "b",
        cwd: "/w",
        task: "t",
        diff: "d",
        cli: "claude",
        model: "haiku",
        binPath: null
      }).pipe(
        Effect.provide(
          Layer.succeed(CliAdapter, {
            run: (_id, spec, ctx) => {
              seen = { readOnly: spec.readOnly, fresh: spec.fresh, model: spec.model }
              return ctx.emit({ _tag: "Assistant", text: "", agentId: undefined })
            },
            stop: () => Effect.void
          })
        )
      )
    )
    expect(seen).toStrictEqual({ readOnly: true, fresh: true, model: "haiku" })
  })
})
