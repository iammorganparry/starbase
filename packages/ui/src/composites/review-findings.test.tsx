import type { ReviewFinding } from "@starbase/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ReviewFindingRow } from "./review-findings.js"

/**
 * A resolved finding is archive, not work. It keeps its place — the record that
 * something was raised and answered — but collapsed, so it can't push the
 * findings that still need attention (and the merge box under them) off-screen.
 */

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({
    id: "f1",
    path: "packages/cli-adapters/src/git.ts",
    line: 169,
    endLine: null,
    severity: "major",
    title: "Regular files are symlinked",
    rationale: "An install in the worktree would rewrite the origin's state.",
    suggestion: "Copy regular files instead of linking them.",
    resolvedBy: null,
    ...over
  }) as ReviewFinding

const RESOLUTION = { sha: "a8451c5", subject: "fix: copy install state" }

// No global auto-cleanup in this suite — without it each render stacks in the
// same DOM and the queries below match the PREVIOUS test's card.
afterEach(cleanup)

describe("ReviewFindingRow", () => {
  it("shows the full card while a finding is outstanding", () => {
    render(<ReviewFindingRow finding={finding()} sent={false} canRoute={false} />)
    expect(screen.getByText(/rewrite the origin's state/)).toBeTruthy()
    expect(screen.getByText(/Copy regular files/)).toBeTruthy()
  })

  it("collapses a RESOLVED finding to its title", () => {
    render(
      <ReviewFindingRow
        finding={finding({ resolvedBy: RESOLUTION } as Partial<ReviewFinding>)}
        sent={false}
        canRoute={false}
      />
    )
    // The title survives — it's the record of what was raised …
    expect(screen.getByRole("button", { name: /Regular files are symlinked/ })).toBeTruthy()
    // … but the bulk is gone.
    expect(screen.queryByText(/rewrite the origin's state/)).toBeNull()
    expect(screen.queryByText(/Copy regular files/)).toBeNull()
  })

  it("re-opens on click, because the detail is what you check a fix against", () => {
    render(
      <ReviewFindingRow
        finding={finding({ resolvedBy: RESOLUTION } as Partial<ReviewFinding>)}
        sent={false}
        canRoute={false}
      />
    )
    const toggle = screen.getByRole("button", { name: /Regular files are symlinked/ })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)

    expect(screen.getByText(/rewrite the origin's state/)).toBeTruthy()
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
  })
})
