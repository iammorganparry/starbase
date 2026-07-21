import type { CliKind } from "@starbase/core"

/**
 * The rules, spelled out. Used verbatim for every harness that cannot see the
 * operator's Claude skills — Codex, Cursor, opencode, the scripted fallback.
 */
const INLINE_RULES = [
  "RESPONSE FORMAT — MANDATORY:",
  "1. First line is an action — a command, a path, or a snippet. Never preamble.",
  "2. Number multi-step work; one bounded action per step.",
  '3. Restate progress every turn ("step 3 of 5 done") — never assume it is held.',
  '4. Give concrete time estimates ("15 minutes"), not "a bit of work".',
  "5. End with ONE next action doable in under two minutes.",
  "",
  'Cap lists at 5 items. State errors matter-of-factly — cause, then fix. Banned: "Great question", "Let me…", "Sure!", "Hope this helps", and recaps of what you just did.',
  'Override this only when the user asks you to "explain" or "walk me through" (then go long, still no preamble).'
].join("\n")

/**
 * The per-turn ADHD instruction, prefixed to the prompt when ADHD mode is on.
 *
 * Claude gets pointed at the operator's `i-have-adhd` skill rather than a copy
 * of its rules: the skill is the source of truth and the operator can edit it
 * without a release. Every other harness has no access to `~/.claude/skills`, so
 * naming the skill there would be a silent no-op — they get the rules inline.
 */
export const adhdNote = (cli: CliKind): string =>
  cli === "claude"
    ? "RESPONSE FORMAT — MANDATORY: invoke the `i-have-adhd:i-have-adhd` skill before replying, and shape this entire reply with it. If that skill is unavailable, follow these rules instead:\n\n" +
      INLINE_RULES
    : INLINE_RULES
