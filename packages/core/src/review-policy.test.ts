import { describe, expect, it } from "vitest"
import type { ReviewFinding, ReviewSeverity } from "./domain.js"
import { ReviewSeverity as ReviewSeveritySchema } from "./domain.js"
import { AGENT_SEVERITIES, PR_SEVERITIES, destinationOf, partitionFindings } from "./review-policy.js"

/**
 * This module decides where a paid-for finding ends up. The behaviour that
 * matters is therefore about LOSS and DOUBLE-COUNTING, not about the sets'
 * contents: a finding must land in exactly one half, and every severity the
 * domain admits must have a home.
 */

const finding = (id: string, severity: ReviewSeverity): ReviewFinding => ({
  id,
  path: "src/a.ts",
  line: 1,
  endLine: null,
  severity,
  title: `${severity} finding`,
  rationale: "because",
  suggestion: null,
  resolvedBy: null
})

describe("partitionFindings", () => {
  it("sends critical and major to the agent, minor and nit to the PR", () => {
    const findings = [
      finding("f1", "critical"),
      finding("f2", "minor"),
      finding("f3", "major"),
      finding("f4", "nit")
    ]
    const { toAgent, toPr } = partitionFindings(findings)
    expect(toAgent.map((f) => f.id)).toStrictEqual(["f1", "f3"])
    expect(toPr.map((f) => f.id)).toStrictEqual(["f2", "f4"])
  })

  /**
   * The one that actually bites. A severity in neither set would make findings
   * disappear — not routed, not posted, not surfaced as either — from a review
   * the user paid a frontier model to produce.
   */
  it("gives every severity in the domain exactly one destination", () => {
    const all = ReviewSeveritySchema.literals
    for (const severity of all) {
      const inAgent = AGENT_SEVERITIES.has(severity)
      const inPr = PR_SEVERITIES.has(severity)
      expect(inAgent !== inPr, `${severity} must be in exactly one set`).toBe(true)
    }
  })

  it("loses no finding across the split", () => {
    const findings = ReviewSeveritySchema.literals.map((s, i) => finding(`f${i}`, s))
    const { toAgent, toPr } = partitionFindings(findings)
    expect(toAgent.length + toPr.length).toBe(findings.length)
  })

  it("preserves the caller's ranking within each half", () => {
    // Worst-first, as `rankFindings` hands them over.
    const findings = [
      finding("a", "critical"),
      finding("b", "critical"),
      finding("c", "nit"),
      finding("d", "nit")
    ]
    const { toAgent, toPr } = partitionFindings(findings)
    expect(toAgent.map((f) => f.id)).toStrictEqual(["a", "b"])
    expect(toPr.map((f) => f.id)).toStrictEqual(["c", "d"])
  })

  it("splits an empty review into two empty halves", () => {
    expect(partitionFindings([])).toStrictEqual({ toAgent: [], toPr: [] })
  })
})

describe("destinationOf", () => {
  it("agrees with the partition for every severity", () => {
    for (const severity of ReviewSeveritySchema.literals) {
      const { toAgent } = partitionFindings([finding("f1", severity)])
      expect(destinationOf(severity)).toBe(toAgent.length === 1 ? "agent" : "pr")
    }
  })
})
