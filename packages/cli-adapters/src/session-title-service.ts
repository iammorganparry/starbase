import type { Message } from "@starbase/core"
import { GitError, buildTitlePrompt, cleanTitle, fallbackTitle } from "@starbase/core"
import { Effect } from "effect"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"

/**
 * Auto-titling: name a session from its transcript and refresh it each turn. The
 * LLM call is isolated behind a `TitleGenerator` seam so `retitleSession` (and its
 * tests) stay deterministic; the live generator folds every failure to a
 * first-message heuristic, so titling never throws and never blocks.
 */

/** A hung `claude` login can't wedge the retitle — bound the one-shot call. */
const TITLE_TIMEOUT = "15 seconds"
/** Cheap/fast model for titling regardless of the session's coding model. */
const TITLE_MODEL = "haiku"

/** Pluggable title source — the injection point for deterministic tests. */
export interface TitleGenerator {
  readonly generate: (messages: ReadonlyArray<Message>) => Effect.Effect<string>
}

/** Concatenated text of an SDK assistant message's `text` content blocks. */
const assistantText = (msg: unknown): string => {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join(" ")
}

/**
 * Live generator: a one-shot Haiku completion via the Claude Agent SDK, which
 * runs on the user's `claude` subscription login (no API key required) and works
 * for both claude and codex sessions. Any error/timeout/empty output folds to the
 * deterministic `fallbackTitle` — so a user without a Claude login still gets a
 * sensible name from their first message.
 */
export const claudeTitleGenerator: TitleGenerator = {
  generate: (messages) =>
    messages.length === 0
      ? Effect.succeed(fallbackTitle(messages))
      : Effect.tryPromise(async () => {
          const { query } = await import("@anthropic-ai/claude-agent-sdk")
          const iterator = query({
            prompt: buildTitlePrompt(messages),
            options: { model: TITLE_MODEL, allowedTools: [], maxTurns: 1, includePartialMessages: false }
          })
          let text = ""
          for await (const m of iterator) {
            if ((m as { type?: string }).type === "assistant") text += assistantText(m)
            if ((m as { type?: string }).type === "result") break
          }
          return text
        }).pipe(
          Effect.timeout(TITLE_TIMEOUT),
          Effect.map((t) => (t.trim().length > 0 ? cleanTitle(t) : fallbackTitle(messages))),
          Effect.orElseSucceed(() => fallbackTitle(messages))
        )
}

/**
 * Regenerate a session's title from its transcript and persist it, returning the
 * updated record. A pinned session (`autoTitle === false`, set by a manual
 * rename) is left untouched with no LLM call. Only the `title` field changes —
 * branch/worktree/id are immutable.
 */
export const retitleSession = (sessionId: string, gen: TitleGenerator) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId)
    // Only auto-named sessions are retitled. `autoTitle` absent ⇒ the session was
    // named by the user (legacy/explicit) and is left pinned.
    if (session.autoTitle !== true) return session
    const messages = yield* TranscriptStore.list(sessionId).pipe(Effect.orElseSucceed(() => []))
    const title = yield* gen.generate(messages)
    if (title !== session.title) yield* SessionStore.setTitle(sessionId, title).pipe(Effect.ignore)
    return { ...session, title }
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () => Effect.fail(new GitError({ message: "Session not found" })))
  )
