import type { Message } from "./conversation.js"

/**
 * Pure helpers for auto-generating a session's title from its transcript. Kept
 * free of Effect/SDK deps so they're trivially unit-tested; the impure one-shot
 * LLM call (cli-adapters `session-title-service`) is a thin wrapper that funnels
 * both its output and its fallback through `cleanTitle`.
 */

/** The provisional title a session carries until the agent names it. */
export const UNTITLED_SESSION = "Untitled session"

/** The concatenated text of a message's `Text` parts. */
const textOf = (message: Message): string =>
  message.parts
    .filter((p): p is Extract<typeof p, { _tag: "Text" }> => p._tag === "Text")
    .map((p) => p.text)
    .join(" ")
    .trim()

/**
 * Normalize a raw model/first-message title into a single clean line: collapse
 * whitespace/newlines, strip surrounding quotes and a trailing period, and clamp
 * to `maxLen` on a word boundary. Empty input → `UNTITLED_SESSION`.
 */
export const cleanTitle = (raw: string, maxLen = 60): string => {
  let t = raw.replace(/\s+/g, " ").trim()
  // Strip a single layer of surrounding quotes (straight or curly).
  const quotes = new Set(['"', "'", "“", "”", "‘", "’"])
  while (t.length >= 2 && quotes.has(t[0]!) && quotes.has(t[t.length - 1]!)) {
    t = t.slice(1, -1).trim()
  }
  t = t.replace(/[.]+$/, "").trim()
  if (t.length === 0) return UNTITLED_SESSION
  if (t.length <= maxLen) return t
  const clamped = t.slice(0, maxLen)
  const lastSpace = clamped.lastIndexOf(" ")
  return (lastSpace > maxLen * 0.5 ? clamped.slice(0, lastSpace) : clamped).trim() + "…"
}

/** The first user message's text, or "". */
const firstUserText = (messages: ReadonlyArray<Message>): string => {
  const first = messages.find((m) => m.role === "user" && textOf(m).length > 0)
  return first ? textOf(first) : ""
}

/**
 * Deterministic fallback title (no LLM): the first user message, cleaned. Used
 * when the titling model is unavailable/errors or returns nothing. Empty
 * transcript → `UNTITLED_SESSION`.
 */
export const fallbackTitle = (messages: ReadonlyArray<Message>): string => {
  const text = firstUserText(messages)
  return text.length > 0 ? cleanTitle(text) : UNTITLED_SESSION
}

/**
 * The prompt handed to the titling model: the request that started the session
 * plus a short slice of the latest assistant reply, with strict instructions to
 * answer with only a terse title. Pure + deterministic for a given transcript.
 */
export const buildTitlePrompt = (messages: ReadonlyArray<Message>): string => {
  const firstUser = firstUserText(messages).slice(0, 800)
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m).length > 0)
  const assistantSlice = lastAssistant ? textOf(lastAssistant).slice(0, 400) : ""
  return [
    "Write a concise 3-6 word title for this coding session, describing what the user is working on.",
    "Reply with ONLY the title — no quotes, no punctuation at the end, no preamble.",
    "",
    `User's request:\n${firstUser}`,
    ...(assistantSlice ? ["", `Agent's latest reply (for context):\n${assistantSlice}`] : [])
  ].join("\n")
}
