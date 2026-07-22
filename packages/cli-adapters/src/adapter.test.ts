import type { StreamEvent } from "@starbase/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  GIGAPLAN_CRITIQUE_PROMPT_MARKER,
  GIGAPLAN_PROPOSAL_PROMPT_MARKER
} from "./adversarial-plan-prompt.js"
import { PlanDecision, scriptedRun } from "./adapter.js"

const runScripted = async (prompt: string): Promise<ReadonlyArray<StreamEvent>> => {
  const events: Array<StreamEvent> = []

  await scriptedRun(0)(
    "session-1",
    {
      cli: "claude",
      repo: "starbase",
      branch: "starbase/test",
      cwd: "/tmp/starbase-test",
      prompt,
      images: [],
      binPath: null,
      mode: "ask",
      model: null,
      resumeId: null
    },
    {
      emit: (event) => Effect.sync(() => events.push(event)),
      canUseTool: () => Effect.succeed("allow"),
      askQuestion: () => Effect.succeed([]),
      proposePlan: () => Effect.succeed(PlanDecision.Reject()),
      registerBackgroundStop: () => Effect.void
    }
  ).pipe(Effect.runPromise)

  return events
}

describe("scripted adversarial-planning fixtures", () => {
  it.each([
    [GIGAPLAN_PROPOSAL_PROMPT_MARKER, "summary: Add deterministic request limits"],
    [GIGAPLAN_CRITIQUE_PROMPT_MARKER, '"challenges": []']
  ])(
    "dispatches %s by its structural marker, independent of prompt prose",
    async (marker, reply) => {
      const events = await runScripted(`${marker}\nThis human-readable opening may change freely.`)
      const assistantText = events
        .filter(
          (event): event is Extract<StreamEvent, { _tag: "Assistant" }> =>
            event._tag === "Assistant"
        )
        .map((event) => event.text)
        .join("")

      expect(assistantText).toContain(reply)
    }
  )
})
