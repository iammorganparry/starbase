import type { PlanChallenge, PlanStep } from "@starbase/core"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ChallengeBadge, PlanChallenges, PlanProvenance } from "./plan-challenges.js"

const step = (over: Partial<PlanStep> = {}): PlanStep =>
  ({
    id: "s1",
    number: "01",
    title: "Add the column",
    intent: "Accounts need a tier.",
    approach: [],
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
  }) as PlanStep

const challenge = (over: Partial<PlanChallenge> = {}): PlanChallenge => ({
  id: "c1",
  severity: "major",
  title: "The backfill runs before the column exists",
  rationale: "Step 02 populates a column step 03 creates.",
  status: "open",
  defence: null,
  ...over
})

describe("PlanChallenges — reviewed vs unreviewed", () => {
  it("says nobody looked when no adversary ran", () => {
    // The distinction the feature lives or dies on: an unreviewed plan must
    // never wear a clean bill of health.
    render(<PlanChallenges step={step()} />)
    expect(screen.getByText(/No rival model reviewed/i)).toBeTruthy()
  })

  it("says a rival looked and found nothing when the list is empty", () => {
    render(<PlanChallenges step={step({ challenges: [] })} />)
    expect(screen.getByText(/raised nothing/i)).toBeTruthy()
  })

  it("never claims approval — only that nothing was raised", () => {
    render(<PlanChallenges step={step({ challenges: [] })} />)
    expect(screen.queryByText(/approved|endorsed|looks good/i)).toBeNull()
  })
})

describe("PlanChallenges — challenge states", () => {
  it("shows an unresolved challenge with its rationale", () => {
    render(<PlanChallenges step={step({ challenges: [challenge()] })} />)
    expect(screen.getByText(/backfill runs before/i)).toBeTruthy()
    expect(screen.getByText("unresolved")).toBeTruthy()
  })

  it("shows a defended challenge WITH the proposer's reason", () => {
    // A defence with no reason shown is indistinguishable from a dismissal, so
    // the objection and the answer must appear together.
    render(
      <PlanChallenges
        step={{
          ...step(),
          challenges: [
            challenge({ status: "defended", defence: "The migration is idempotent." })
          ]
        }}
      />
    )
    expect(screen.getByText("defended")).toBeTruthy()
    expect(screen.getByText(/migration is idempotent/i)).toBeTruthy()
  })

  it("marks an addressed challenge without a defence", () => {
    render(<PlanChallenges step={step({ challenges: [challenge({ status: "addressed" })] })} />)
    expect(screen.getByText("addressed")).toBeTruthy()
  })
})

describe("ChallengeBadge", () => {
  it("renders nothing when no adversary ran", () => {
    const { container } = render(<ChallengeBadge step={step()} />)
    expect(container.firstChild).toBeNull()
  })

  it("counts only the unresolved ones", () => {
    // A defended challenge is answered — surfacing it as outstanding would train
    // the reader to ignore the badge.
    render(
      <ChallengeBadge
        step={step({
          challenges: [
            challenge({ id: "a", status: "open" }),
            challenge({ id: "b", status: "addressed" }),
            challenge({ id: "c", status: "defended", defence: "fine" })
          ]
        })}
      />
    )
    expect(screen.getByText("1")).toBeTruthy()
  })

  it("shows an examined marker when nothing is outstanding", () => {
    render(<ChallengeBadge step={step({ challenges: [] })} />)
    expect(screen.getByLabelText(/Examined by a rival model/i)).toBeTruthy()
  })
})

describe("PlanProvenance", () => {
  it("renders nothing for an ordinary single-agent plan", () => {
    const { container } = render(<PlanProvenance step={step()} />)
    expect(container.firstChild).toBeNull()
  })

  it("names the proposing model and the vendor behind it", () => {
    render(
      <PlanProvenance
        step={step({ origin: { cli: "claude", model: "claude-fable-5", vendor: "anthropic" } })}
      />
    )
    expect(screen.getByText("claude-fable-5")).toBeTruthy()
    expect(screen.getByText(/anthropic/)).toBeTruthy()
  })

  it("shows the assignee's own stated reason", () => {
    render(
      <PlanProvenance
        step={step({
          assignee: { cli: "codex", model: "gpt-5.6-sol", reason: "stronger on migrations here" }
        })}
      />
    )
    expect(screen.getByText(/stronger on migrations here/)).toBeTruthy()
  })

  it("labels the evidence level so a prior never reads as a measurement", () => {
    render(
      <PlanProvenance
        step={step({
          assignee: {
            cli: "codex",
            model: "gpt-5.6-sol",
            reason: "schema work",
            evidence: { level: "prior", observations: 0 }
          }
        })}
      />
    )
    expect(screen.getByText(/\[prior, n=0\]/)).toBeTruthy()
  })
})
