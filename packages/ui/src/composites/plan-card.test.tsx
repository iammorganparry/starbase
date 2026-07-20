import type { ExecutionMode, Plan } from "@starbase/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanCard } from "./plan-card.js"
import { PlanStepList } from "./plan-step-list.js"
import { PlanReview } from "../screens/plan-review.js"

afterEach(cleanup)

const plan: Plan = {
  id: "p1",
  summary: "Ship the feature",
  status: "proposed",
  structured: true,
  raw: "Ship the feature",
  comments: [],
  steps: [
    {
      id: "s1",
      number: "01",
      title: "Implement it",
      intent: "Build the approved change.",
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
      assignee: {
        cli: "codex",
        model: "gpt-5.6-sol",
        reason: "Best fit for implementation"
      }
    }
  ]
}

describe("PlanCard approval", () => {
  it("offers the selected mode and an explicit auto path as one grouped choice", () => {
    const approvals: Array<ExecutionMode | undefined> = []
    render(<PlanCard plan={plan} onApprove={(mode) => approvals.push(mode)} />)

    const group = screen.getByRole("group", { name: "Plan approval options" })
    expect(group).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Approve and auto$/ }))

    expect(approvals).toStrictEqual([undefined, "auto"])
  })
})

describe("Plan step assignments", () => {
  it("makes the assigned provider and model visible in the step navigator", () => {
    render(<PlanStepList plan={plan} />)

    expect(screen.getByLabelText("Assigned to codex gpt-5.6-sol")).toBeTruthy()
  })
})

describe("compact Plan Review", () => {
  it("opens the step detail without squeezing fixed-width navigation and changes rails beside it", () => {
    render(<PlanReview plan={plan} compact />)

    expect(screen.getByText("Assigned model")).toBeTruthy()
    expect(screen.queryByLabelText("Resize step list")).toBeNull()
    expect(screen.queryByLabelText("Resize changes")).toBeNull()
  })
})
