import { describe, expect, it } from "vitest"
import { formatQuestionAnswers, parseQuestionBlock, QUESTION_FENCE, questionNote } from "./question-prompt.js"

/**
 * The rule these cover: an agent that asks in prose has not asked at all — the
 * text renders as ordinary chat with nothing to click, so the question is
 * silently ignored and the agent guesses anyway. The instruction has to reach
 * every harness, and Codex's fenced channel has to survive a small model's
 * formatting rather than collapsing into a dead card.
 */

const block = (body: unknown) => `\`\`\`${QUESTION_FENCE}\n${JSON.stringify(body)}\n\`\`\``

const asked = {
  questions: [
    {
      question: "Which store should hold the token?",
      header: "Token store",
      multiSelect: false,
      options: [
        { label: "TokenStore", description: "New service, isolated." },
        { label: "MemoryStore", description: "Reuse what exists." }
      ]
    }
  ]
}

describe("questionNote", () => {
  it("forbids prose questions on every harness", () => {
    for (const cli of ["claude", "codex", "cursor", "opencode"] as const) {
      expect(questionNote(cli)).toContain("Never ask in prose")
    }
  })

  // Asking and then guessing in the same reply is not asking: the answer lands
  // after the decision has already been made.
  it("tells the agent to stop and wait", () => {
    expect(questionNote("claude")).toContain("stop and wait")
  })

  // The channel genuinely differs per harness, and naming the wrong one is a
  // silent no-op — Codex has no AskUserQuestion tool to invoke.
  it("names the channel each harness actually has", () => {
    expect(questionNote("claude")).toContain("AskUserQuestion")
    expect(questionNote("codex")).toContain(QUESTION_FENCE)
    expect(questionNote("codex")).not.toContain("AskUserQuestion")
    expect(questionNote("cursor")).not.toContain("AskUserQuestion")
  })

  // Left unqualified, the rule turns every turn into an interrogation.
  it("says when NOT to ask", () => {
    expect(questionNote("claude")).toContain("sensible default")
  })
})

describe("parseQuestionBlock", () => {
  it("reads a well-formed block", () => {
    const found = parseQuestionBlock(block(asked))
    expect(found!.questions).toHaveLength(1)
    expect(found!.questions[0]!.header).toBe("Token store")
    expect(found!.questions[0]!.options).toHaveLength(2)
  })

  // The prose around a question is still part of the reply; swallowing it with
  // the block would drop the reasoning that made the question make sense.
  it("keeps the surrounding prose and drops the block", () => {
    const found = parseQuestionBlock(`I need one decision first.\n\n${block(asked)}`)
    expect(found!.stripped).toBe("I need one decision first.")
    expect(found!.stripped).not.toContain(QUESTION_FENCE)
  })

  // Same reading `extractJson` takes for digests: a model that restates and
  // corrects itself meant the last one.
  it("takes the last block when a model restates itself", () => {
    const second = {
      questions: [
        {
          question: "Actually — which database?",
          header: "DB",
          options: [
            { label: "Postgres", description: "…" },
            { label: "SQLite", description: "…" }
          ]
        }
      ]
    }
    const found = parseQuestionBlock(`${block(asked)}\n\n${block(second)}`)
    expect(found!.questions[0]!.header).toBe("DB")
  })

  it("carries multiSelect through", () => {
    const multi = { questions: [{ ...asked.questions[0]!, multiSelect: true }] }
    expect(parseQuestionBlock(block(multi))!.questions[0]!.multiSelect).toBe(true)
  })

  // Every rejection path returns null on purpose. The block then stays in the
  // reply as ordinary text — no worse than before this channel existed, and far
  // better than docking an empty card the operator can neither answer nor
  // dismiss, which would park the run forever.
  it("returns null rather than producing an unanswerable card", () => {
    expect(parseQuestionBlock("no fence here at all")).toBeNull()
    expect(parseQuestionBlock(`\`\`\`${QUESTION_FENCE}\nnot json\n\`\`\``)).toBeNull()
    expect(parseQuestionBlock(block({ questions: [] }))).toBeNull()
    // A question with nothing to pick from is not a question.
    expect(parseQuestionBlock(block({ questions: [{ question: "Which?", options: [] }] }))).toBeNull()
    // …and neither is a set of options with no question.
    expect(
      parseQuestionBlock(block({ questions: [{ question: "  ", options: [{ label: "a", description: "b" }] }] }))
    ).toBeNull()
  })

  // A plain ```json block is a different thing; only our fence opts in.
  it("ignores fences that are not ours", () => {
    expect(parseQuestionBlock(`\`\`\`json\n${JSON.stringify(asked)}\n\`\`\``)).toBeNull()
  })
})

describe("formatQuestionAnswers", () => {
  it("states the picks and tells the model to continue", () => {
    const out = formatQuestionAnswers(asked.questions, [{ selected: ["TokenStore"], other: null }])
    expect(out).toContain("Token store: TokenStore")
    expect(out).toContain("do not ask again")
  })

  it("carries a free-text answer alongside the picks", () => {
    const out = formatQuestionAnswers(asked.questions, [{ selected: ["TokenStore"], other: "or a Ref" }])
    expect(out).toContain("TokenStore, or a Ref")
  })

  // A stop resolves pending questions with [], so this path is reached whenever
  // an operator halts a run that was parked on a question.
  it("says plainly when nothing was picked", () => {
    expect(formatQuestionAnswers(asked.questions, [])).toContain("(no selection)")
  })
})
