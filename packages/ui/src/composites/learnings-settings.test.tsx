import type { Outcome } from "@starbase/core"
import { toContribution } from "@starbase/cli-adapters"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { applyToggle, LearningsSettings, SHARED_FIELDS } from "./learnings-settings.js"

const outcome: Outcome = {
  id: "s1",
  repoKey: "repo-a",
  taskKind: "schema",
  cli: "codex",
  vendor: "openai",
  model: "gpt-5.6-sol",
  signals: {
    findingsCritical: 0,
    findingsMajor: 0,
    findingsMinor: 0,
    findingsNit: 0,
    ciPassed: true,
    merged: true,
    filesReverted: 0,
    planRevisions: 0
  },
  sizeBucket: "m",
  confidence: "exact",
  score: 2,
  occurredOn: "2026-07-18"
}

const props = {
  enabled: true,
  sharing: true,
  evalJudge: false,
  onChange: vi.fn(),
  organisationName: "Acme",
  storagePaths: ["~/starbase/outcomes"],
  learned: [],
  onPurge: vi.fn()
}

describe("the promise matches the payload", () => {
  it("names EVERY field a shared record actually carries", () => {
    // The guard that keeps this pane honest. A promise about data that has
    // drifted from the code is worse than no promise, so the list is derived
    // from `toContribution` rather than trusted — add a field to the wire shape
    // and this fails until the copy names it too.
    const actual = Object.keys(toContribution(outcome)).sort()
    const promised = SHARED_FIELDS.map((f) => f.name).sort()
    expect(promised).toEqual(actual)
  })

  it("claims nothing that is not sent", () => {
    // The other direction: over-promising is also a lie, and it would make the
    // pane read as more invasive than the code is.
    const actual = new Set(Object.keys(toContribution(outcome)))
    for (const field of SHARED_FIELDS) expect(actual.has(field.name)).toBe(true)
  })
})

describe("LearningsSettings", () => {
  it("states the real on-disk locations", () => {
    render(<LearningsSettings {...props} storagePaths={["~/starbase/outcomes"]} />)
    expect(screen.getByText("~/starbase/outcomes")).toBeTruthy()
  })

  it("names the organisation, never just an id", () => {
    render(<LearningsSettings {...props} />)
    expect(screen.getAllByText(/Share learnings with Acme/).length).toBeGreaterThan(0)
  })

  it("explains rather than silently disabling sharing with no organisation", () => {
    render(<LearningsSettings {...props} organisationName={null} sharing={false} />)
    expect(screen.getAllByText(/not in an organisation/i).length).toBeGreaterThan(0)
  })

  it("says a prior is a starting belief, not a measurement", () => {
    render(
      <LearningsSettings
        {...props}
        learned={[
          { repoKey: "r", taskKind: "schema", model: "m", observations: 0, level: "prior", estimate: 0.55 }
        ]}
      />
    )
    expect(screen.getAllByText(/starting belief, no evidence yet/).length).toBeGreaterThan(0)
  })

  it("reports how much evidence is behind a real cell", () => {
    render(
      <LearningsSettings
        {...props}
        learned={[
          { repoKey: "r", taskKind: "schema", model: "m", observations: 19, level: "repo-model", estimate: 0.8 }
        ]}
      />
    )
    expect(screen.getAllByText(/19 tasks \(repo-model\)/).length).toBeGreaterThan(0)
  })

  it("says nothing is known rather than showing an empty table", () => {
    render(<LearningsSettings {...props} learned={[]} />)
    expect(screen.getAllByText(/Nothing yet/).length).toBeGreaterThan(0)
  })

  it("is clear that a purge leaves teammates' contributions alone", () => {
    render(<LearningsSettings {...props} />)
    expect(screen.getAllByText(/contributions are untouched/).length).toBeGreaterThan(0)
  })
})

describe("applyToggle — fail closed", () => {
  const on = { enabled: true, sharing: true, evalJudge: true }

  it("turning learning off turns everything off", () => {
    // Not cosmetic: a stale `true` would come back to life the moment learning
    // was re-enabled, having survived the operator switching it all off.
    expect(applyToggle(on, { enabled: false })).toStrictEqual({
      enabled: false,
      sharing: false,
      evalJudge: false
    })
  })

  it("cannot turn a dependant on while the master is off", () => {
    const off = { enabled: false, sharing: false, evalJudge: false }
    expect(applyToggle(off, { sharing: true })).toStrictEqual(off)
    expect(applyToggle(off, { evalJudge: true })).toStrictEqual(off)
  })

  it("leaves the other switches alone otherwise", () => {
    expect(applyToggle(on, { sharing: false })).toStrictEqual({
      enabled: true,
      sharing: false,
      evalJudge: true
    })
  })
})
