import type { CliKind, Question, QuestionAnswer } from "@starbase/core"

/**
 * The fence Codex answers questions through.
 *
 * Codex has no `canUseTool` callback — `mapCodexPolicy` pins `approvalPolicy`
 * to "never" precisely because there is nothing interactive to call back into —
 * so unlike Claude there is no tool for us to intercept. A fenced block in the
 * assistant text is the only channel the harness actually gives us, and it is
 * enough: the adapter parses it into the same `QuestionRequest` the Claude path
 * produces, so the operator sees the identical question card either way.
 */
export const QUESTION_FENCE = "question"

/** The JSON shape asked for inside the fence. Mirrors `QuestionRequest`. */
const SHAPE = `\`\`\`${QUESTION_FENCE}
{
  "questions": [
    {
      "question": "The full question, ending in a question mark.",
      "header": "Short label, max 12 chars",
      "multiSelect": false,
      "options": [
        { "label": "1-5 words", "description": "What choosing this means, and its trade-off." },
        { "label": "1-5 words", "description": "…" }
      ]
    }
  ]
}
\`\`\``

/**
 * Why the rule exists, stated once and shared by every harness.
 *
 * The "stop and wait" half is load-bearing. A model that asks and then guesses
 * in the same reply has not really asked — the operator's answer arrives after
 * the work is already done, and the question card becomes a receipt for a
 * decision they never made.
 */
const WHY = [
  "ASKING QUESTIONS — MANDATORY:",
  "Whenever you need a decision from the user — an ambiguous requirement, a choice between approaches, a missing value, anything you would otherwise guess at — you MUST ask through the structured question channel described below. Never ask in prose.",
  "",
  "A question asked in prose does not reach the user as a question: it renders as ordinary chat text with no way to answer it, so it is silently ignored and you end up guessing anyway.",
  "",
  "When you ask: stop and wait for the answer. Do not ask and then proceed on an assumption in the same reply.",
  "Do not ask when a sensible default exists, when the codebase already answers it, or to confirm work you were plainly asked to do — take the obvious option and say which you took."
].join("\n")

/**
 * The per-turn instruction telling an agent to ask through its native channel.
 *
 * Prefixed to every turn, alongside `adhdNote`, for the same reason that one is:
 * there is no system-prompt hook shared by all harnesses, and a rule that has to
 * survive a mid-session harness switch has to ride the prompt body.
 *
 * Per-CLI because the channel genuinely differs. Claude has a real tool, which
 * the adapter intercepts in `canUseTool`; Codex has the fenced block above;
 * everything else has neither, so it is told to hand the user a numbered choice
 * rather than to invoke something that does not exist.
 */
export const questionNote = (cli: CliKind): string => {
  if (cli === "claude") {
    return `${WHY}\n\nUse the \`AskUserQuestion\` tool. It is the only channel that reaches the user as an answerable question.`
  }
  if (cli === "codex") {
    return `${WHY}\n\nAsk by emitting a fenced \`${QUESTION_FENCE}\` block, on its own, as the last thing in your reply — then stop. It is parsed into the user's question UI and their answers come back to you on the next turn. Emit at most one block per reply, with 1-4 questions in it, each with 2-4 options.\n\n${SHAPE}`
  }
  return `${WHY}\n\nYou have no structured question channel, so make the question impossible to miss: put it on the FIRST line of your reply, offer numbered options, and stop there without doing further work.`
}

// ── Reading a fenced question block back ─────────────────────────────────────

const strOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null

/** Matches the fenced block, capturing its body. Global: we take the LAST one. */
const FENCE_RE = new RegExp(`\`\`\`${QUESTION_FENCE}\\s*([\\s\\S]*?)\`\`\``, "g")

/**
 * Pull a question block out of an assistant reply.
 *
 * Returns `null` for anything we cannot turn into a real question — no fence,
 * unparseable JSON, or questions with no options. That is deliberately the
 * quiet path: the block stays in the reply and renders as ordinary text, which
 * is no worse than the behaviour before this existed. Throwing, or surfacing an
 * empty question card, would turn a model's formatting slip into a dead end the
 * operator cannot answer or dismiss.
 *
 * `stripped` is the reply with the block removed, so the prose around a question
 * still reaches the transcript instead of being swallowed with it.
 */
export const parseQuestionBlock = (
  text: string
): { questions: ReadonlyArray<Question>; stripped: string } | null => {
  const matches = [...text.matchAll(FENCE_RE)]
  if (matches.length === 0) return null
  // Last, not first: when a model restates and corrects itself, the final block
  // is the one it meant — the same reading `extractJson` takes for digests.
  const match = matches[matches.length - 1]!
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? "")
  } catch {
    return null
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const raw = Array.isArray(record.questions) ? (record.questions as Array<Record<string, unknown>>) : []
  const questions = raw
    .map((q): Question => {
      const opts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []
      return {
        question: strOf(q.question) ?? "",
        header: strOf(q.header) ?? "",
        multiSelect: q.multiSelect === true,
        options: opts.map((o) => {
          const preview = strOf(o.preview)
          return {
            label: strOf(o.label) ?? "",
            description: strOf(o.description) ?? "",
            ...(preview ? { preview } : {})
          }
        })
      }
    })
    .filter((q) => q.question.length > 0 && q.options.length > 0)
  if (questions.length === 0) return null
  return { questions, stripped: text.replace(FENCE_RE, "").trim() }
}

/**
 * Format the operator's picks as the text the model reads next.
 *
 * Shared by both channels that can ask: Claude hands this back through
 * `canUseTool`'s deny message (the only field that returns content to the
 * model), Codex gets it as the prompt of a follow-up turn. Same wording either
 * way, so a session that switches harness mid-flight reads consistently.
 */
export const formatQuestionAnswers = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>
): string => {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    const picks = a ? [...a.selected, ...(a.other ? [a.other] : [])] : []
    return `• ${q.header || q.question}: ${picks.join(", ") || "(no selection)"}`
  })
  return `The user answered your question(s):\n${lines.join("\n")}\n\nUse these answers and continue — do not ask again.`
}
