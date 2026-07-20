import type { WorkspaceConfig } from "./domain.js"
import { describe, expect, it } from "vitest"
import { ORCHESTRATOR_DEFAULT, resolveOrchestrator } from "./orchestrator.js"

const config = (over: Partial<WorkspaceConfig> = {}): WorkspaceConfig =>
  ({ reposDir: "/repos", createdAt: "2026-01-01T00:00:00.000Z", ...over }) as WorkspaceConfig

describe("resolveOrchestrator", () => {
  it("defaults to Claude Opus", () => {
    // A flagship on purpose: this model plans, and reads whole repositories to
    // do it. Defaulting to something cheap would make the orchestrator's own
    // judgement the weakest link in a feature that is entirely about judgement.
    expect(resolveOrchestrator(null)).toStrictEqual({ cli: "claude", model: "opus" })
    expect(resolveOrchestrator(config())).toStrictEqual(ORCHESTRATOR_DEFAULT)
  })

  it("honours the operator's choice", () => {
    expect(
      resolveOrchestrator(config({ orchestrator: { cli: "codex", model: "gpt-5.6-sol" } }))
    ).toStrictEqual({ cli: "codex", model: "gpt-5.6-sol" })
  })

  it("refuses to make the orchestrator its own backend", () => {
    // Reachable by a hand-edited config or an older build; left alone it would
    // recurse — the orchestrator resolving to itself, forever.
    expect(
      resolveOrchestrator(config({ orchestrator: { cli: "starbase", model: "auto" } }))
    ).toStrictEqual(ORCHESTRATOR_DEFAULT)
  })
})
