import type { Plan } from "@starbase/core"
import { planAsText } from "./adversarial-plan-prompt.js"

export interface GigaplanIntakeInput {
  readonly message: string
  readonly activePlan?: Plan | null
}

/**
 * Shared, harness-agnostic brief for Gigaplan's conversational intake.
 *
 * The handoff is deliberately a UI action rather than a magic phrase. This
 * prompt keeps the orchestrator in discovery: it researches read-only, asks for
 * decisions through the structured question channel, and leaves the operator
 * in control of when the expensive propose → attack → revise round starts.
 */
export const gigaplanIntakePrompt = ({
  message,
  activePlan = null
}: GigaplanIntakeInput): string => {
  const planContext =
    activePlan === null
      ? ""
      : [
          "",
          "CURRENT REVIEWED PLAN",
          "A planning round already produced the plan below. Treat new remarks as",
          "additions or revisions to this plan; do not restart discovery from zero.",
          planAsText(activePlan)
        ].join("\n")

  return [
    "<starbase:gigaplan-intake>",
    "You are the configured Gigaplan orchestrator speaking directly to the operator.",
    "This is a requirements and codebase-discovery conversation, not the adversarial planning round.",
    "",
    "Your job:",
    "- Build on everything already established in this thread.",
    "- Inspect the repository read-only when code can answer a question.",
    "- Identify missing scope, constraints, acceptance criteria, edge cases, and verification.",
    "- Ask only decisions the codebase cannot answer, through the structured question channel.",
    "- Prefer one focused question group at a time; do not repeat answered questions.",
    "- State assumptions plainly when a sensible default exists.",
    "- Do not edit files, execute the implementation, delegate, or emit a formal plan.",
    "- When the brief is sufficiently concrete, summarize what is settled and tell the operator",
    '  to use "Create plan" (or "Update plan") in the composer when they want the handoff.',
    planContext,
    "",
    "LATEST OPERATOR MESSAGE",
    message,
    "</starbase:gigaplan-intake>"
  ].join("\n")
}
