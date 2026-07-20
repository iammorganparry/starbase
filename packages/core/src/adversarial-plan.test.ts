import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { PlanRound, settledPlan, wasScrutinised } from "./adversarial-plan.js"
import type { Plan, PlanChallenge, PlanStep } from "./conversation.js"
import { PlanStep as PlanStepSchema, unresolvedChallenges, wasChallenged } from "./conversation.js"

/** A step as written before adversarial planning existed — no new fields at all. */
const legacyStep = {
  id: "s1",
  number: "01",
  title: "Refactor auth",
  intent: "Make the token path testable",
  approach: ["extract the store"],
  kind: "step",
  condition: null,
  parentId: null,
  dependsOn: [],
  blocks: [],
  files: [],
  guards: [],
  diff: null,
  status: "proposed",
  flagged: false
}

const challenge = (over: Partial<PlanChallenge> = {}): PlanChallenge => ({
  id: "c1",
  severity: "major",
  title: "The backfill runs before the column exists",
  rationale: "Step 02 populates a column step 03 creates, so it fails on a fresh database.",
  status: "open",
  defence: null,
  ...over
})

const step = (over: Partial<PlanStep> = {}): PlanStep =>
  ({ ...(legacyStep as unknown as PlanStep), ...over })

describe("PlanStep adversarial fields", () => {
  it("decodes a step written before adversarial planning existed", () => {
    // The regression that matters: a required field here fails to decode every
    // pre-existing transcript, which blanks the whole conversation.
    const decoded = Schema.decodeUnknownSync(PlanStepSchema)(legacyStep)
    expect(decoded.origin).toBeUndefined()
    expect(decoded.challenges).toBeUndefined()
    expect(decoded.assignee).toBeUndefined()
    expect(decoded.taskKind).toBeUndefined()
  })

  it("round-trips a fully adversarial step", () => {
    const full = {
      ...legacyStep,
      origin: { cli: "claude", model: "claude-fable-5", vendor: "anthropic" },
      taskKind: "schema",
      challenges: [challenge()],
      assignee: {
        cli: "codex",
        model: "gpt-5.6-sol",
        reason: "schema work, and OpenAI has the stronger record here",
        evidence: { level: "repo-model", observations: 19 }
      }
    }
    const decoded = Schema.decodeUnknownSync(PlanStepSchema)(full)
    expect(decoded.origin?.vendor).toBe("anthropic")
    expect(decoded.assignee?.evidence?.observations).toBe(19)
  })

  it("distinguishes 'reviewed, nothing found' from 'never reviewed'", () => {
    // Collapsing these would let an unreviewed plan read as an endorsed one.
    expect(wasChallenged(step({ challenges: [] }))).toBe(true)
    expect(wasChallenged(step())).toBe(false)
  })
})

describe("unresolvedChallenges", () => {
  it("returns only what the revision never engaged with", () => {
    const s = step({
      challenges: [
        challenge({ id: "open", status: "open" }),
        challenge({ id: "fixed", status: "addressed" })
      ]
    })
    expect(unresolvedChallenges(s).map((c) => c.id)).toEqual(["open"])
  })

  it("does not count a defended challenge as unresolved", () => {
    // `defended` means the proposer answered and kept its approach — a real
    // disagreement on the record, not an ignored objection.
    const s = step({
      challenges: [challenge({ status: "defended", defence: "The migration is idempotent." })]
    })
    expect(unresolvedChallenges(s)).toEqual([])
  })

  it("is empty for a step nobody challenged", () => {
    expect(unresolvedChallenges(step())).toEqual([])
  })
})

describe("PlanRound", () => {
  const plan = (id: string): Plan => ({
    id,
    summary: "Add a tier column",
    steps: [],
    comments: [],
    status: "proposed",
    structured: true,
    raw: "# plan"
  })

  const round = (over: Partial<PlanRound> = {}): PlanRound => ({
    id: "r1",
    sessionId: "s1",
    createdAt: "2026-07-18T10:00:00.000Z",
    proposer: { cli: "claude", model: "claude-fable-5", vendor: "anthropic" },
    adversary: { cli: "codex", model: "gpt-5.6-sol", vendor: "openai" },
    proposal: plan("p1"),
    critique: null,
    revised: null,
    outcome: "clean",
    ...over
  })

  it("settles on the revision when there was one, else the proposal", () => {
    expect(settledPlan(round()).id).toBe("p1")
    expect(settledPlan(round({ revised: plan("p2"), outcome: "revised" })).id).toBe("p2")
  })

  it("reports a clean round as scrutinised and an unchallenged one as not", () => {
    // The most misleading thing this feature could do is present "nobody looked"
    // as "a rival lab found nothing".
    expect(wasScrutinised(round({ outcome: "clean" }))).toBe(true)
    expect(wasScrutinised(round({ outcome: "unchallenged", adversary: null }))).toBe(false)
  })

  it("round-trips through the schema", () => {
    const full = round({
      critique: {
        by: { cli: "codex", model: "gpt-5.6-sol", vendor: "openai" },
        challenges: [challenge()],
        targets: ["s1"],
        note: null
      },
      revised: plan("p2"),
      outcome: "revised"
    })
    const encoded = Schema.encodeSync(PlanRound)(full)
    expect(Schema.decodeUnknownSync(PlanRound)(encoded)).toStrictEqual(full)
  })
})
