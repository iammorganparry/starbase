import type { ContentPart, Message } from "@starbase/core"
import { describe, expect, it } from "vitest"
import {
  digestPrompt,
  lastMessageId,
  parseDigest,
  renderPrimer,
  renderTranscript,
  tailAfter
} from "./context-digest.js"

/**
 * The digest is the only lossy step in the whole feature, so these tests are
 * mostly about what must NOT be lost — decisions, answered questions, file
 * paths — and about refusing to produce a half-summary, which would reseed a
 * conversation with an undetectable hole in it.
 */

const msg = (id: string, role: "user" | "assistant", parts: ReadonlyArray<ContentPart>): Message => ({
  id,
  role,
  parts,
  streaming: false,
  createdAt: "2026-07-19T00:00:00.000Z"
})

const text = (t: string): ContentPart => ({ _tag: "Text", text: t })

const tool = (over: Partial<Parameters<typeof toolPart>[0]> = {}): ContentPart => toolPart({ ...over })

const toolPart = (o: {
  name?: string
  target?: string | null
  status?: "running" | "success" | "error"
  meta?: string | null
  diff?: { added: number; removed: number } | null
  output?: string
}): ContentPart => ({
  _tag: "Tool",
  tool: {
    id: "t1",
    name: o.name ?? "Read",
    target: o.target ?? "src/a.ts",
    status: o.status ?? "success",
    meta: o.meta ?? null,
    diff: o.diff ?? null,
    preview: null,
    ...(o.output === undefined ? {} : { output: o.output })
  }
})

describe("renderTranscript", () => {
  it("is deterministic for a fixed transcript", () => {
    const messages = [msg("m1", "user", [text("add rate limiting")]), msg("m2", "assistant", [text("done")])]
    expect(renderTranscript(messages)).toBe(renderTranscript(messages))
  })

  it("labels each turn with its number and role", () => {
    const out = renderTranscript([
      msg("m1", "user", [text("add rate limiting")]),
      msg("m2", "assistant", [text("Added the middleware.")])
    ])
    expect(out).toContain("## Turn 1 — user")
    expect(out).toContain("add rate limiting")
    expect(out).toContain("## Turn 2 — assistant")
  })

  // Thinking is the largest single contributor to a transcript and the least
  // useful to a successor: the reasoning that produced a decision is worth far
  // less than the decision, which the assistant text states outright.
  it("drops thinking blocks entirely", () => {
    const out = renderTranscript([
      msg("m1", "assistant", [
        { _tag: "Thinking", text: "SECRET REASONING", seconds: 4, streaming: false },
        text("Added the middleware.")
      ])
    ])
    expect(out).not.toContain("SECRET REASONING")
    expect(out).toContain("Added the middleware.")
  })

  // Keeping a Bash run's 40k of log tells the next conversation nothing it can
  // act on; that the command ran and passed tells it everything.
  it("keeps the tool call but drops its output", () => {
    const out = renderTranscript([
      msg("m1", "assistant", [
        tool({ name: "Bash", target: "npm test", meta: "1 passed", output: "VERBOSE LOG SPEW" })
      ])
    ])
    expect(out).toContain("Bash npm test (1 passed)")
    expect(out).not.toContain("VERBOSE LOG SPEW")
  })

  it("records a failed tool call as failed", () => {
    const out = renderTranscript([msg("m1", "assistant", [tool({ name: "Bash", status: "error" })])])
    expect(out).toContain("FAILED")
  })

  it("carries edit line counts so the successor knows the shape of the change", () => {
    const out = renderTranscript([
      msg("m1", "assistant", [tool({ name: "Edit", target: "src/auth.ts", diff: { added: 12, removed: 3 } })])
    ])
    expect(out).toContain("Edit src/auth.ts [+12 -3]")
  })

  // An answered question is an explicit, recorded human decision — the
  // highest-value thing in the transcript. Losing it makes the agent re-ask
  // something the user already settled, which reads as amnesia.
  it("preserves answered questions as decisions", () => {
    const out = renderTranscript([
      msg("m1", "assistant", [
        {
          _tag: "Question",
          request: {
            id: "q1",
            questions: [
              {
                question: "Which token strategy?",
                header: "Strategy",
                multiSelect: false,
                options: [
                  { label: "Rotating", description: "…" },
                  { label: "Sliding", description: "…" }
                ]
              }
            ]
          },
          answers: [{ selected: ["Rotating"], other: null }]
        }
      ])
    ])
    expect(out).toContain("Which token strategy?")
    expect(out).toContain("Rotating")
  })

  it("omits an unanswered question, which is about to be re-asked anyway", () => {
    const out = renderTranscript([
      msg("m1", "assistant", [
        {
          _tag: "Question",
          request: {
            id: "q1",
            questions: [{ question: "Pending?", header: "P", multiSelect: false, options: [] }]
          },
          answers: null
        }
      ])
    ])
    expect(out).not.toContain("Pending?")
  })

  it("degrades an image to its filename rather than re-embedding base64", () => {
    const out = renderTranscript([
      msg("m1", "user", [
        {
          _tag: "Image",
          attachment: { id: "a1", name: "screenshot.png", mediaType: "image/png", data: "AAAABBBBCCCC" }
        }
      ])
    ])
    expect(out).toContain("[image: screenshot.png]")
    expect(out).not.toContain("AAAABBBBCCCC")
  })

  it("skips a message with nothing renderable rather than emitting an empty block", () => {
    const out = renderTranscript([
      msg("m1", "assistant", [{ _tag: "Thinking", text: "only thinking", seconds: 1, streaming: false }]),
      msg("m2", "user", [text("real content")])
    ])
    expect(out).not.toContain("## Turn 1")
    expect(out).toContain("real content")
  })

  describe("elision", () => {
    // 400 turns of 2k chars each blows any budget. The middle is the most
    // compressible part and the least likely to be load-bearing.
    const huge = [
      msg("m1", "user", [text("ORIGINAL GOAL: build the thing")]),
      msg("m2", "assistant", [text("starting")]),
      ...Array.from({ length: 400 }, (_, i) => msg(`mid${i}`, "assistant", [text("x".repeat(1_900))])),
      msg("last", "assistant", [text("MOST RECENT STATE")])
    ]

    it("stays within the render budget", () => {
      expect(renderTranscript(huge).length).toBeLessThanOrEqual(240_000)
    })

    // Dropping a suffix would summarise a conversation while ignoring what just
    // happened in it; dropping the head would lose why the session exists.
    it("keeps both the original goal and the most recent state", () => {
      const out = renderTranscript(huge)
      expect(out).toContain("ORIGINAL GOAL: build the thing")
      expect(out).toContain("MOST RECENT STATE")
    })

    it("says out loud how much it dropped", () => {
      expect(renderTranscript(huge)).toMatch(/\d+ earlier turns elided/)
    })

    it("does not elide a transcript that already fits", () => {
      expect(renderTranscript([msg("m1", "user", [text("short")])])).not.toContain("elided")
    })
  })
})

describe("lastMessageId", () => {
  it("names the newest message, or null when there is nothing to digest", () => {
    expect(lastMessageId([msg("m1", "user", [text("a")]), msg("m2", "user", [text("b")])])).toBe("m2")
    expect(lastMessageId([])).toBeNull()
  })
})

describe("digestPrompt", () => {
  it("names every field the parser requires", () => {
    const p = digestPrompt("RENDERED")
    for (const field of ["goal", "decisions", "filesTouched", "openThreads", "preferences"]) {
      expect(p).toContain(field)
    }
    expect(p).toContain("RENDERED")
  })

  // The model runs on the cheapest tier available, so the instruction states the
  // stakes plainly rather than relying on it to infer them.
  it("tells the model its output replaces the conversation", () => {
    expect(digestPrompt("x")).toContain("REPLACES this conversation")
  })
})

describe("parseDigest", () => {
  const at = "2026-07-19T12:00:00.000Z"
  const good = JSON.stringify({
    goal: "Add rate limiting to the refund route",
    decisions: ["Reused the token bucket in lib/ratelimit.ts rather than adding a dependency"],
    filesTouched: ["src/routes/billing.ts"],
    openThreads: ["The 429 test is still failing"],
    preferences: ["Prefers Effect over raw async"]
  })

  it("parses a clean fenced reply", () => {
    const digest = parseDigest(`\`\`\`json\n${good}\n\`\`\``, "m9", at)
    expect(digest).not.toBeNull()
    expect(digest!.goal).toContain("rate limiting")
    expect(digest!.decisions).toHaveLength(1)
    expect(digest!.throughMessageId).toBe("m9")
    expect(digest!.builtAt).toBe(at)
  })

  // Small models garnish. Rather than demand obedience, tolerate the garnish.
  it("tolerates prose around the fence", () => {
    expect(parseDigest(`Sure! Here's the summary:\n\n\`\`\`json\n${good}\n\`\`\`\n\nHope that helps!`, "m9", at))
      .not.toBeNull()
  })

  it("tolerates a fence with no language tag", () => {
    expect(parseDigest(`\`\`\`\n${good}\n\`\`\``, "m9", at)).not.toBeNull()
  })

  it("tolerates a bare object with no fence at all", () => {
    expect(parseDigest(good, "m9", at)).not.toBeNull()
  })

  // When a model restates and corrects itself, the final answer is the intended
  // one — so the LAST block wins, not the first.
  it("takes the last block when the model restates itself", () => {
    const first = JSON.stringify({ goal: "WRONG", decisions: [], filesTouched: [], openThreads: [], preferences: [] })
    const digest = parseDigest(`\`\`\`json\n${first}\n\`\`\`\nActually:\n\`\`\`json\n${good}\n\`\`\``, "m9", at)
    expect(digest!.goal).not.toBe("WRONG")
  })

  // `null` is a real answer: the caller responds by not compacting, leaving the
  // session exactly as it behaves today. A partial digest would be far worse —
  // it reseeds with an undetectable hole, which the user experiences as the
  // agent forgetting things at random.
  it("returns null rather than a partial digest when a field is missing", () => {
    expect(parseDigest(`\`\`\`json\n{"goal":"x"}\n\`\`\``, "m9", at)).toBeNull()
  })

  it("returns null on a wrong field type", () => {
    const bad = JSON.stringify({ goal: "x", decisions: "not an array", filesTouched: [], openThreads: [], preferences: [] })
    expect(parseDigest(bad, "m9", at)).toBeNull()
  })

  it("returns null on malformed json", () => {
    expect(parseDigest("```json\n{ not json at all\n```", "m9", at)).toBeNull()
  })

  it("returns null when there is no object at all", () => {
    expect(parseDigest("I'm sorry, I can't help with that.", "m9", at)).toBeNull()
  })

  // A summary that cannot say what the session is FOR has failed at its only job,
  // even though every other field decoded.
  it("returns null on an empty goal", () => {
    const bad = JSON.stringify({ goal: "   ", decisions: [], filesTouched: [], openThreads: [], preferences: [] })
    expect(parseDigest(bad, "m9", at)).toBeNull()
  })

  it("accepts empty arrays, which a short session legitimately produces", () => {
    const thin = JSON.stringify({ goal: "Explore the codebase", decisions: [], filesTouched: [], openThreads: [], preferences: [] })
    expect(parseDigest(thin, "m9", at)).not.toBeNull()
  })
})

describe("tailAfter", () => {
  const messages = [msg("m1", "user", [text("a")]), msg("m2", "assistant", [text("b")]), msg("m3", "user", [text("c")])]

  it("returns only what landed after the digest was built", () => {
    expect(tailAfter(messages, "m1").map((m) => m.id)).toStrictEqual(["m2", "m3"])
  })

  it("returns nothing when the digest covers everything", () => {
    expect(tailAfter(messages, "m3")).toHaveLength(0)
  })

  // Too much context costs tokens; too little costs correctness. Replay everything.
  it("replays the whole transcript when the id is gone", () => {
    expect(tailAfter(messages, "vanished")).toHaveLength(3)
  })
})

describe("renderPrimer", () => {
  const digest = {
    goal: "Add rate limiting to the refund route",
    decisions: ["Reused the token bucket rather than adding a dependency"],
    filesTouched: ["src/routes/billing.ts"],
    openThreads: ["The 429 test is still failing"],
    preferences: ["Prefers Effect over raw async"],
    throughMessageId: "m2",
    builtAt: "2026-07-19T12:00:00.000Z"
  }

  it("carries every section of the digest", () => {
    const primer = renderPrimer(digest, [])
    expect(primer).toContain("Add rate limiting to the refund route")
    expect(primer).toContain("Reused the token bucket")
    expect(primer).toContain("src/routes/billing.ts")
    expect(primer).toContain("429 test")
    expect(primer).toContain("Prefers Effect")
  })

  // Told this is a briefing from a third party, models re-introduce themselves
  // and re-ask settled questions. Told it is their own memory, they continue.
  it("frames the summary as the agent's own memory, not a third-party briefing", () => {
    const primer = renderPrimer(digest, [])
    expect(primer).toContain("YOUR OWN prior context")
    expect(primer).toContain("do not re-ask")
  })

  // What makes a stale digest safe: compaction prepares in the background and
  // applies on the next turn, so more conversation can land in between.
  it("replays post-digest turns verbatim", () => {
    const primer = renderPrimer(digest, [msg("m3", "user", [text("also add a 429 test")])])
    expect(primer).toContain("also add a 429 test")
    expect(primer).toContain("MOST RECENT TURNS")
  })

  it("omits the verbatim section when the digest is already current", () => {
    expect(renderPrimer(digest, [])).not.toContain("MOST RECENT TURNS")
  })

  it("omits empty sections rather than emitting bare headers", () => {
    const thin = { ...digest, decisions: [], openThreads: [], preferences: [], filesTouched: [] }
    const primer = renderPrimer(thin, [])
    expect(primer).not.toContain("DECISIONS")
    expect(primer).not.toContain("OPEN THREADS")
    expect(primer).toContain("Add rate limiting")
  })
})
