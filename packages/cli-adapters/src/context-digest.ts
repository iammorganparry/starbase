import type { ContextDigest, ContentPart, Message } from "@starbase/core"
import { Schema } from "effect"

/**
 * Turning our own transcript into a primer for a fresh harness conversation.
 *
 * This is the whole reason the feature is harness-agnostic: `TranscriptStore`
 * already holds a normalized `Message[]` for every session regardless of which
 * CLI produced it, so summarising it needs no `/compact`, no per-harness command,
 * and no cooperation from the vendor. Claude, Codex and opencode all get the
 * identical treatment.
 *
 * Everything here is PURE and deterministic — the model call lives in
 * `ContextManager`. That split is what makes the interesting parts testable
 * without a harness, a login, or a network.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Cap on a single text part. Long agent prose is where the tokens are, and the
 * opening lines carry nearly all the meaning — an answer that rambles for 8k
 * characters has usually said its piece in the first few hundred.
 */
const MAX_PART_CHARS = 2_000

/**
 * Cap on the whole rendered transcript, in characters.
 *
 * This has to fit the DIGEST model's window, not the session model's — and the
 * digest deliberately runs on the cheapest tier available (haiku, ~200k tokens).
 * At roughly 3.7 chars/token, 240k chars is ~65k tokens, which leaves ample room
 * for the instructions and the reply even if the estimate is well off.
 *
 * Getting this wrong is quiet: the digest run would just fail in a background
 * fiber, compaction would never happen, and the only symptom would be a session
 * that mysteriously kept rotting.
 */
const MAX_RENDER_CHARS = 240_000

/** How many leading messages survive elision — the original ask sets the goal. */
const KEEP_LEADING = 2

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [truncated]`

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render one content part as a compact line, or null to omit it entirely.
 *
 * The omissions are the point:
 *  - `Thinking` is dropped. It is the single largest contributor to a
 *    transcript and the least useful to a successor — reasoning that led to a
 *    decision is worth far less than the decision, which the assistant text
 *    states outright.
 *  - `ToolCall.output` is dropped, keeping only the call and its shape. A Bash
 *    run's 40k of log tells the next conversation nothing it can act on; that
 *    the command ran and passed tells it everything.
 *  - `Image` degrades to a filename. Re-embedding base64 payloads into a
 *    summarisation prompt would be absurd, and the digest model may not even be
 *    multimodal.
 */
const renderPart = (part: ContentPart): string | null => {
  switch (part._tag) {
    case "Text": {
      const text = part.text.trim()
      return text.length === 0 ? null : truncate(text, MAX_PART_CHARS)
    }
    case "Thinking":
      return null
    case "Image":
      return `[image: ${part.attachment.name}]`
    case "Tool": {
      const t = part.tool
      const target = t.target === null ? "" : ` ${t.target}`
      const meta = t.meta === null ? "" : ` (${t.meta})`
      const diff = t.diff === null ? "" : ` [+${t.diff.added} -${t.diff.removed}]`
      const failed = t.status === "error" ? " — FAILED" : ""
      return `- ${t.name}${target}${meta}${diff}${failed}`
    }
    case "Gate": {
      // Only settled gates matter. A gate still pending at digest time is about
      // to be re-asked anyway.
      if (part.gate.status === "pending") return null
      return `- [${part.gate.status}] ${part.gate.title}`
    }
    case "Question": {
      // The highest-value lines in the whole render: an explicit, recorded human
      // decision. A summary that loses these makes the agent re-ask something the
      // user already answered, which reads as amnesia.
      if (part.answers === null) return null
      const qs = part.request.questions
      return part.answers
        .map((a, i) => {
          const picked = [...a.selected, ...(a.other === null ? [] : [a.other])].join(", ")
          return `- Q: ${qs[i]?.question ?? "(question)"} → A: ${picked || "(none)"}`
        })
        .join("\n")
    }
    case "Context":
      // A previous compaction, being summarised again. Carrying the earlier goal
      // forward is what stops a twice-compacted session from drifting: the second
      // digest sees an explicit statement of intent rather than a transcript that
      // appears to begin mid-conversation.
      return `- EARLIER CONTEXT COMPACTED — goal at that point: ${part.digest.goal}`
    case "Plan": {
      const steps = part.plan.steps
        .filter((s) => s.kind !== "branch-arm")
        .map((s) => `  ${s.number}. ${s.title} [${s.status}]`)
        .join("\n")
      return `- PLAN: ${part.plan.summary}\n${steps}`
    }
  }
}

/** Render one message as a `## Turn N — role` block, or null when it says nothing. */
const renderMessage = (message: Message, index: number): string | null => {
  const body = message.parts
    .map(renderPart)
    .filter((line): line is string => line !== null)
    .join("\n")
    .trim()
  if (body.length === 0) return null
  return `## Turn ${index + 1} — ${message.role}\n${body}`
}

/**
 * Render a transcript to bounded markdown, deterministically.
 *
 * When the render exceeds `MAX_RENDER_CHARS` the MIDDLE is elided, never the
 * ends. The opening turns carry the session's original goal, and the recent
 * turns carry its live state; the middle is the most compressible part and the
 * least likely to be load-bearing. Dropping a suffix would summarise a
 * conversation while ignoring what just happened in it.
 */
export const renderTranscript = (messages: ReadonlyArray<Message>): string => {
  const blocks = messages
    .map((m, i) => ({ id: m.id, text: renderMessage(m, i) }))
    .filter((b): b is { id: string; text: string } => b.text !== null)

  const joined = blocks.map((b) => b.text).join("\n\n")
  if (joined.length <= MAX_RENDER_CHARS) return joined

  const leading = blocks.slice(0, KEEP_LEADING)
  let used = leading.reduce((n, b) => n + b.text.length + 2, 0)
  const trailing: Array<string> = []
  // Walk backwards from the newest turn, taking as much recent history as fits.
  for (let i = blocks.length - 1; i >= KEEP_LEADING; i--) {
    const block = blocks[i]!
    if (used + block.text.length + 2 > MAX_RENDER_CHARS) break
    trailing.unshift(block.text)
    used += block.text.length + 2
  }
  const elided = blocks.length - leading.length - trailing.length
  return [
    ...leading.map((b) => b.text),
    `## […] ${elided} earlier turn${elided === 1 ? "" : "s"} elided to fit the summary budget`,
    ...trailing
  ].join("\n\n")
}

/** The id of the last message a digest built now would cover, or null if empty. */
export const lastMessageId = (messages: ReadonlyArray<Message>): string | null =>
  messages.length === 0 ? null : messages[messages.length - 1]!.id

// ── The digest prompt ────────────────────────────────────────────────────────

/**
 * The instruction handed to the background run.
 *
 * Written to be answered by a SMALL model, because that is what it runs on: the
 * shape is fixed, the fields are named, and nothing requires judgement beyond
 * faithful extraction. It also states the stakes plainly — the model is told its
 * output replaces the conversation, which measurably improves how much detail
 * survives versus asking for a generic "summary".
 */
export const digestPrompt = (rendered: string): string =>
  `You are compacting a coding session's context. Below is a record of the conversation so far.

Your summary REPLACES this conversation. The agent that reads it will have no other memory of what happened — if you omit something, it is gone, and the agent will contradict earlier decisions or redo finished work.

Extract, faithfully and specifically:
- goal: what the user is ultimately trying to achieve, in one or two sentences.
- recentWork: the last 3-6 things that actually happened, OLDEST FIRST, ending with the most recent. Name the command, the file and the outcome: "ran pnpm test — 3 failures in context-manager.test.ts", "added the stopping state to conversation-machine.ts and typecheck passed". This is what the agent did just before the summary; it is how it knows not to redo work or claim progress it cannot describe.
- nextStep: the ONE action the session was about to take next, in a single line. Not the backlog — the immediate next move, e.g. "re-run pnpm typecheck now that the import is fixed". Empty string only if the last exchange genuinely closed.
- decisions: choices that were made AND the reasoning, e.g. "chose X over Y because Z". Include every decision that would be expensive to relitigate.
- filesTouched: repo-relative paths that were created or modified.
- openThreads: everything else left unfinished — known bugs, agreed follow-ups. Do not repeat nextStep here.
- preferences: standing instructions from the user that must keep applying (style, tools, constraints, tone).
- midFlow: true if the session is in the MIDDLE of something whose working state a summary would destroy — a half-finished edit sequence, a live debugging thread chasing a specific failure, a plan being executed step by step, a question the user has not answered yet. False if the last exchange reached a natural boundary: work landed, a question answered, a topic closed.
- midFlowReason: one short line naming what is in flight. Empty string when midFlow is false.

Rules:
- Be specific. "Refactored the auth code" is useless; "moved token handling from MemoryStore into TokenStore in src/auth/token-store.ts" is not.
- Never invent. If a field has nothing, use an empty array.
- Do not describe the conversation ("the user asked…"); state the resulting facts.

Reply with ONLY a fenced json code block, no prose before or after:

\`\`\`json
{
  "goal": "…",
  "recentWork": ["…"],
  "nextStep": "…",
  "decisions": ["…"],
  "filesTouched": ["…"],
  "openThreads": ["…"],
  "preferences": ["…"],
  "midFlow": false,
  "midFlowReason": ""
}
\`\`\`

--- CONVERSATION RECORD ---

${rendered}`

// ── Parsing ──────────────────────────────────────────────────────────────────

/** The model-supplied half of a digest — the rest is stamped by us, not asked for. */
const DigestReply = Schema.Struct({
  goal: Schema.String,
  decisions: Schema.Array(Schema.String),
  filesTouched: Schema.Array(Schema.String),
  openThreads: Schema.Array(Schema.String),
  preferences: Schema.Array(Schema.String)
})

/**
 * The mid-flow verdict, read LENIENTLY and deliberately outside `DigestReply`.
 *
 * Putting it in the schema would make a small model's stray `"midFlow": "yes"`
 * reject the entire digest — trading a good summary for a formatting slip, on
 * the cheapest tier, where formatting slips are the norm. A verdict we cannot
 * read means "we don't know", and not knowing must never hold a session open:
 * it falls back to false, i.e. today's behaviour.
 */
/**
 * The short-term-memory fields, read LENIENTLY and outside `DigestReply` for
 * the same reason as `midFlow`.
 *
 * These two are the difference between a compacted agent that picks up where it
 * left off and one that re-plans from scratch — but they are also the two a
 * small model is most likely to fumble, because they ask for prose rather than
 * a copy of something already in the transcript. Rejecting an otherwise good
 * digest over `"recentWork": "…"` (a string where an array was asked for) would
 * trade the whole summary for a formatting slip, on the cheapest tier, where
 * formatting slips are the norm. Absent or malformed reads as "nothing to say",
 * which degrades to exactly the primer we rendered before these existed.
 */
const readShortTerm = (parsed: unknown): { recentWork: ReadonlyArray<string>; nextStep: string } => {
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const raw = record.recentWork
  // A lone string is the common near-miss — take it as a one-item list rather
  // than discarding what the model plainly meant.
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  const recentWork = list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const nextStep = typeof record.nextStep === "string" ? record.nextStep.trim() : ""
  return { recentWork, nextStep }
}

const readMidFlow = (parsed: unknown): { midFlow: boolean; midFlowReason?: string } => {
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const midFlow = record.midFlow === true
  const reason = typeof record.midFlowReason === "string" ? record.midFlowReason.trim() : ""
  return midFlow && reason.length > 0 ? { midFlow, midFlowReason: reason } : { midFlow }
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Small models are the ones running this, and they garnish: a stray "Here's the
 * summary:" before the fence, or a fence without a language tag. Rather than
 * demand obedience, take the LAST balanced `{…}` span — last, because when a
 * model restates and corrects itself the final answer is the intended one.
 */
const extractJson = (raw: string): string | null => {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  const candidate = fenced.length > 0 ? fenced[fenced.length - 1]![1]! : raw
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

/**
 * Parse a model reply into a digest, or `null` if it cannot be trusted.
 *
 * `null` is a real answer here, not an error path to be smoothed over: the
 * caller responds by NOT compacting, leaving the session exactly as it is today
 * with the harness's own limit as backstop. A partial digest would be far worse
 * — it reseeds the conversation with a hole in it that nothing downstream can
 * detect, and the user would experience it as the agent forgetting things at
 * random.
 */
export const parseDigest = (
  raw: string,
  throughMessageId: string,
  builtAt: string
): ContextDigest | null => {
  const json = extractJson(raw)
  if (json === null) return null
  try {
    const parsed: unknown = JSON.parse(json)
    const reply = Schema.decodeUnknownSync(DigestReply)(parsed)
    // A digest with no goal is not a digest. Everything else may legitimately be
    // empty (a short session has made no decisions yet), but a summary that
    // cannot say what the session is FOR has failed at the only job it has.
    if (reply.goal.trim().length === 0) return null
    return { ...reply, ...readShortTerm(parsed), ...readMidFlow(parsed), throughMessageId, builtAt }
  } catch {
    return null
  }
}

// ── The primer ───────────────────────────────────────────────────────────────

const bullets = (label: string, items: ReadonlyArray<string>): string =>
  items.length === 0 ? "" : `\n\n${label}\n${items.map((i) => `- ${i}`).join("\n")}`

/**
 * Render the digest (plus any turns that landed after it was built) into the
 * text that seeds the fresh conversation.
 *
 * The `tail` is what makes a stale digest safe. Compaction prepares in the
 * background and applies on the NEXT turn, so more conversation can happen in
 * between; replaying those messages verbatim after the summary is cheaper and
 * more faithful than rebuilding the digest, and it means the digest never has to
 * be raced against the user.
 *
 * The framing matters: the agent is told this is a compaction of its OWN prior
 * context, not a briefing from a third party. Told the latter, models tend to
 * re-introduce themselves and re-ask settled questions.
 */
export const renderPrimer = (
  digest: ContextDigest,
  tail: ReadonlyArray<Message>
): string => {
  const tailRendered = tail
    .map((m, i) => renderMessage(m, i))
    .filter((line): line is string => line !== null)
    .join("\n\n")

  // Ordered the way an agent picking the thread back up needs it: where we're
  // going, what just happened, what to do next — and only then the reference
  // material (decisions, files, backlog, standing preferences). Putting the
  // backlog before the next action is what makes a compacted agent re-plan.
  const nextStep =
    digest.nextStep === undefined || digest.nextStep.trim().length === 0
      ? ""
      : `\n\nTHE IMMEDIATE NEXT ACTION\n${digest.nextStep.trim()}`

  return `[CONTEXT COMPACTED]

This session has been running long enough that its earlier context was summarised to keep quality high. What follows is YOUR OWN prior context in condensed form — treat it as memory you already have, not as a briefing from someone else. Do not re-introduce yourself, do not re-ask anything settled below, and do not redo work listed as already done.

GOAL
${digest.goal}${bullets("WHAT I JUST DID (most recent last)", digest.recentWork ?? [])}${nextStep}${bullets("DECISIONS ALREADY MADE (do not relitigate)", digest.decisions)}${bullets("FILES TOUCHED", digest.filesTouched)}${bullets("OTHER OPEN THREADS", digest.openThreads)}${bullets("STANDING USER PREFERENCES (keep applying these)", digest.preferences)}${
    tailRendered.length === 0
      ? ""
      : `\n\nMOST RECENT TURNS (verbatim, these happened after the summary above)\n\n${tailRendered}`
  }

[END COMPACTED CONTEXT — the user's next message follows]`
}

/** Messages after `throughMessageId`; the whole list when the id is not found. */
export const tailAfter = (
  messages: ReadonlyArray<Message>,
  throughMessageId: string
): ReadonlyArray<Message> => {
  const idx = messages.findIndex((m) => m.id === throughMessageId)
  // Not found means the digest refers to a message that is no longer in the
  // transcript. Replaying everything is the safe read: too much context costs
  // tokens, too little costs correctness.
  return idx === -1 ? messages : messages.slice(idx + 1)
}
