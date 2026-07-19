import { describe, expect, it } from "vitest"
import type { ReviewFinding } from "./domain.js"
import { resolveFindings, resolvedCount, type ResolvingCommit } from "./review-resolution.js"

/**
 * Attribution is a heuristic, so what these tests pin is its CONSERVATISM: the
 * ways it declines to claim a finding is fixed matter more than the way it
 * claims one is. A false "resolved" tells the operator a defect is handled when
 * it is not, which is the one failure mode worth designing against.
 */

const AT = "2026-07-19T12:00:00.000Z"

const finding = (over: Partial<ReviewFinding> & { id: string }): ReviewFinding => ({
  path: "src/auth.ts",
  line: 12,
  endLine: null,
  severity: "major",
  title: "t",
  rationale: "r",
  suggestion: null,
  resolvedBy: null,
  ...over
})

const commit = (sha: string, files: string[], subject = `fix ${sha}`): ResolvingCommit => ({
  sha,
  subject,
  files
})

describe("resolveFindings", () => {
  it("credits the commit that touched the finding's file", () => {
    const [out] = resolveFindings([finding({ id: "f1" })], [commit("aaa", ["src/auth.ts"])], AT)
    expect(out?.resolvedBy).toStrictEqual({ sha: "aaa", subject: "fix aaa", at: AT })
  })

  it("leaves a finding whose file nothing touched outstanding", () => {
    const findings = [finding({ id: "f1" })]
    // Same array back — callers use identity to skip a persist and a re-render.
    expect(resolveFindings(findings, [commit("aaa", ["src/other.ts"])], AT)).toBe(findings)
  })

  it("returns the same array when there are no commits at all", () => {
    const findings = [finding({ id: "f1" })]
    expect(resolveFindings(findings, [], AT)).toBe(findings)
  })

  it("never resolves a finding with no path", () => {
    // A finding about the change as a whole has no file to match. Resolving it
    // off "some commit happened" would close every general finding the moment
    // anything landed.
    const findings = [finding({ id: "f1", path: null })]
    expect(resolveFindings(findings, [commit("aaa", ["src/auth.ts"])], AT)).toBe(findings)
  })

  it("credits the FIRST matching commit, not the most recent", () => {
    // Commits arrive oldest-first. A later edit to the same file is almost
    // certainly other work — crediting it would make the attribution drift
    // forwards every time the file is touched again.
    const [out] = resolveFindings(
      [finding({ id: "f1" })],
      [commit("older", ["src/auth.ts"]), commit("newer", ["src/auth.ts"])],
      AT
    )
    expect(out?.resolvedBy?.sha).toBe("older")
  })

  it("never re-attributes an already-resolved finding", () => {
    // The resolution is a fact about the commit that closed it. Re-running
    // reconciliation (which happens after every turn) must not move it.
    const already = finding({
      id: "f1",
      resolvedBy: { sha: "first", subject: "first fix", at: "2026-07-18T00:00:00.000Z" }
    })
    const [out] = resolveFindings([already], [commit("later", ["src/auth.ts"])], AT)
    expect(out?.resolvedBy?.sha).toBe("first")
  })

  it("resolves only the findings whose own file was touched", () => {
    const out = resolveFindings(
      [finding({ id: "f1", path: "src/auth.ts" }), finding({ id: "f2", path: "src/other.ts" })],
      [commit("aaa", ["src/auth.ts"])],
      AT
    )
    expect(out[0]?.resolvedBy?.sha).toBe("aaa")
    expect(out[1]?.resolvedBy).toBeNull()
  })

  it("resolves several findings in one file from a single commit", () => {
    const out = resolveFindings(
      [finding({ id: "f1" }), finding({ id: "f2" })],
      [commit("aaa", ["src/auth.ts", "src/other.ts"])],
      AT
    )
    expect(out.every((f) => f.resolvedBy?.sha === "aaa")).toBe(true)
  })

  it("ignores a commit that touched nothing (a merge)", () => {
    const findings = [finding({ id: "f1" })]
    expect(resolveFindings(findings, [commit("merge", [])], AT)).toBe(findings)
  })
})

describe("resolvedCount", () => {
  it("counts only attributed findings", () => {
    expect(
      resolvedCount([
        finding({ id: "f1", resolvedBy: { sha: "a", subject: "s", at: AT } }),
        finding({ id: "f2" })
      ])
    ).toBe(1)
  })
})
