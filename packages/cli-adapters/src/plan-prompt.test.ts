import { describe, expect, it } from "vitest"
import { parsePlan, planInstructions, planModeInstructions } from "./plan-parse.js"
import { planNote } from "./plan-prompt.js"

describe("planNote", () => {
  it("is null for Claude, which has a real tool to be steered toward", () => {
    // Restating the protocol in the prompt body would compete with the
    // `planModeInstructions` SDK option the adapter already passes.
    expect(planNote("claude")).toBe(null)
  })

  it("is null for harnesses that cannot plan at all", () => {
    // cursor falls through to the scripted stub; starbase orchestrates.
    expect(planNote("cursor")).toBe(null)
    expect(planNote("starbase")).toBe(null)
  })

  it("hands codex and opencode the identical protocol", () => {
    // The two differ only in transport. A note that drifted between them would
    // mean a plan parses on one harness and degrades to raw text on the other.
    expect(planNote("codex")).toBe(planNote("opencode"))
    expect(planNote("codex")).toContain("```plan")
  })

  it("tells the harness it is read-only, not merely that it should behave", () => {
    // The sandbox enforces this (`mapCodexPolicy`); saying so stops the model
    // burning a turn on an edit it will watch get rejected.
    expect(planNote("codex")).toContain("READ-ONLY")
  })

  it("never tells a non-Claude harness to call ExitPlanMode", () => {
    // The whole reason plan mode was Claude-only: steering a harness toward a
    // tool it does not have produces a turn that ends with nothing submitted.
    expect(planNote("codex")).not.toContain("ExitPlanMode")
    expect(planModeInstructions).toContain("ExitPlanMode")
  })
})

describe("the reply-channel grammar agrees with the real parser", () => {
  // `planInstructions` is shared between the two channels precisely so the
  // grammar cannot drift — but "shared" is only worth anything if the grammar
  // itself parses. A plan written exactly as the reply note describes must
  // survive `parsePlan`, or a Codex plan renders as unreviewable raw markdown.
  const written = [
    "```plan",
    "summary: Add a tier column to accounts",
    "01 Add the column",
    "  intent: Accounts need a billing tier.",
    "  approach: write the migration; run it",
    "  files: A migrations/003_tier.sql +12",
    "  guards: the migration is idempotent; the backfill is resumable (warn)",
    "  blocks: 02",
    "02 Backfill from billing",
    "  intent: Existing accounts need a value.",
    "  approach: batch update",
    "  files: M scripts/backfill.ts +40 -3",
    "  depends: 01",
    "```",
    "",
    "Some human-readable prose below the block.",
    "",
    "```flow step 02",
    'start   n0 "batch starts"',
    'decision n1 "rows remaining?"',
    'action  n2 "update 500 rows"',
    'terminal n3 "done"',
    "n0 -> n1",
    "n1 -> n2 : yes",
    "n1 -> n3 : no",
    "n2 -> n1",
    "```"
  ].join("\n")

  const plan = parsePlan(written, "p1")

  it("parses the summary and both steps", () => {
    expect(plan.structured).toBe(true)
    expect(plan.summary).toBe("Add a tier column to accounts")
    expect(plan.steps.map((s) => s.number)).toEqual(["01", "02"])
  })

  it("parses the fields the note documents", () => {
    const first = plan.steps[0]!
    expect(first.intent).toBe("Accounts need a billing tier.")
    expect(first.approach).toEqual(["write the migration", "run it"])
    expect(first.files.map((f) => f.path)).toEqual(["migrations/003_tier.sql"])
    expect(first.guards.map((g) => g.status)).toEqual(["ok", "warn"])
    expect(plan.steps[1]!.dependsOn).toEqual(["01"])
  })

  it("parses the per-step flow block the note documents", () => {
    expect(plan.steps[1]!.graph?.nodes.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3"])
    expect(plan.steps[1]!.graph?.edges.map((e) => e.label)).toContain("yes")
  })

  it("keeps both channels on one grammar", () => {
    // The two notes differ ONLY in the opening sentence and the submit rule.
    // Everything from the flow-block section down is byte-identical — which is
    // the guarantee that a plan written by Codex parses like one written by
    // Claude.
    const grammarOf = (s: string) => s.slice(s.indexOf("ALSO, for each step"))
    expect(grammarOf(planInstructions("reply"))).toBe(grammarOf(planInstructions("tool")))
    expect(planInstructions("reply")).toContain("Format of the ```plan block")
  })
})
