import type { Message, ToolPart } from "@starbase/core"
import { Message as MessageSchema } from "@starbase/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { harnessLogPath, rebuildTranscript } from "./transcript-backfill.js"

/**
 * The backfill exists to repair transcripts a truncating write zeroed. What
 * matters is that a rebuilt transcript is INDISTINGUISHABLE from one the live
 * runner wrote: same part order, same tool cards, same id scheme, and — above
 * all — decodable, since `TranscriptStore.readAll` turns a decode failure into an
 * empty transcript, which looks exactly like the data loss being repaired.
 */

const line = (o: Record<string, unknown>) => JSON.stringify(o)

const assistant = (content: unknown[], timestamp = "2026-07-18T10:00:00.000Z") =>
  line({ type: "assistant", timestamp, message: { role: "assistant", content } })

const user = (content: unknown[], timestamp = "2026-07-18T10:00:00.000Z") =>
  line({ type: "user", timestamp, message: { role: "user", content } })

const text = (t: string) => ({ type: "text", text: t })
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name,
  input
})
const toolResult = (id: string, content: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error: isError
})

const partTags = (m: Message) => m.parts.map((p) => p._tag)
const toolsOf = (m: Message) => m.parts.filter((p): p is ToolPart => p._tag === "Tool").map((p) => p.tool)

describe("rebuildTranscript", () => {
  it("rebuilds a prompt → reply turn as user + assistant messages", () => {
    const out = rebuildTranscript(
      "s1",
      [user([text("add a login form")]), assistant([text("On it.")])].join("\n")
    )

    expect(out).toHaveLength(2)
    expect(out[0]!.role).toBe("user")
    expect(out[0]!.parts).toStrictEqual([{ _tag: "Text", text: "add a login form" }])
    expect(out[1]!.role).toBe("assistant")
    expect(out[1]!.parts).toStrictEqual([{ _tag: "Text", text: "On it." }])
  })

  it("recovers assistant text, which the live SDK mapping deliberately skips", () => {
    // The whole reason the rebuild can't just delegate to `streamEventsFor`:
    // live, assistant text arrives as `stream_event` token deltas, so the SDK
    // mapping ignores text blocks on the completed message. The stored log has
    // no deltas — only those blocks — so without special handling EVERY assistant
    // reply would come back empty and the backfill would be worthless.
    const out = rebuildTranscript("s1", assistant([text("the answer is 42")]))

    expect(out).toHaveLength(1)
    expect(out[0]!.parts).toStrictEqual([{ _tag: "Text", text: "the answer is 42" }])
  })

  it("keeps text interleaved with tool calls in their original order", () => {
    // Guards the block-by-block replay. Replaying a whole message at once would
    // append the injected text AFTER the tool calls, silently reordering the
    // narration away from the work it describes.
    const out = rebuildTranscript(
      "s1",
      [
        assistant([
          text("First I'll look."),
          toolUse("t1", "Bash", { command: "ls" }),
          text("Now I'll write.")
        ]),
        user([toolResult("t1", "a.ts\nb.ts")])
      ].join("\n")
    )

    expect(partTags(out[0]!)).toStrictEqual(["Text", "Tool", "Text"])
    expect((out[0]!.parts[0] as { text: string }).text).toBe("First I'll look.")
    expect((out[0]!.parts[2] as { text: string }).text).toBe("Now I'll write.")
  })

  it("settles a tool card from its tool_result, carrying output and status", () => {
    const out = rebuildTranscript(
      "s1",
      [
        assistant([toolUse("t1", "Bash", { command: "npm test" })]),
        user([toolResult("t1", "42 passing")])
      ].join("\n")
    )

    const [tool] = toolsOf(out[0]!)
    expect(tool!.name).toBe("Bash")
    // Target derivation is the adapter's, not ours — proof we reuse it.
    expect(tool!.target).toBe("npm test")
    expect(tool!.status).toBe("success")
    expect(tool!.output).toContain("42 passing")
  })

  it("marks a failed tool_result as an error card", () => {
    const out = rebuildTranscript(
      "s1",
      [
        assistant([toolUse("t1", "Bash", { command: "npm test" })]),
        user([toolResult("t1", "1 failing", true)])
      ].join("\n")
    )

    expect(toolsOf(out[0]!)[0]!.status).toBe("error")
  })

  it("starts a new turn on each real prompt, but not on a bare tool_result", () => {
    // A user line carrying only tool_result is the harness returning output
    // mid-turn. Treating it as a prompt would shatter one turn into many and
    // insert empty user bubbles into the rebuilt history.
    const out = rebuildTranscript(
      "s1",
      [
        user([text("first")]),
        assistant([toolUse("t1", "Bash", { command: "ls" })]),
        user([toolResult("t1", "ok")]),
        assistant([text("done")]),
        user([text("second")]),
        assistant([text("also done")])
      ].join("\n")
    )

    expect(out.map((m) => m.role)).toStrictEqual(["user", "assistant", "user", "assistant"])
    expect(partTags(out[1]!)).toStrictEqual(["Tool", "Text"])
  })

  it("numbers ids the way AgentRunner does, so a later run cannot collide", () => {
    // AgentRunner re-seeds its counter from the max trailing number in the
    // transcript. Ids that don't match `<u|a>_<sid>_<n>` re-seed it to 0, and the
    // next run re-emits ids that collide with these — the virtualized list then
    // stacks rows keyed by them.
    const out = rebuildTranscript(
      "sid",
      [user([text("hi")]), assistant([text("hello")]), user([text("again")]), assistant([text("yes")])].join("\n")
    )

    expect(out.map((m) => m.id)).toStrictEqual(["u_sid_1", "a_sid_2", "u_sid_3", "a_sid_4"])
    const trailing = out.map((m) => Number(m.id.split("_").pop()))
    expect(trailing).toStrictEqual([...trailing].sort((a, b) => a - b))
  })

  it("leaves no message still marked streaming", () => {
    // A rebuilt turn is finished by definition. A `streaming: true` message would
    // render as a live, in-progress turn with a spinner that never resolves.
    const out = rebuildTranscript(
      "s1",
      [user([text("hi")]), assistant([text("working"), toolUse("t1", "Bash", { command: "ls" })])].join("\n")
    )

    expect(out.every((m) => !m.streaming)).toBe(true)
  })

  it("skips harness bookkeeping lines that carry no conversation", () => {
    const out = rebuildTranscript(
      "s1",
      [
        line({ type: "mode", mode: "auto" }),
        line({ type: "last-prompt", promptId: "p1" }),
        line({ type: "attachment", attachment: {} }),
        line({ type: "queue-operation", op: "enqueue" }),
        user([text("hi")]),
        assistant([text("hello")])
      ].join("\n")
    )

    expect(out).toHaveLength(2)
    expect(out.map((m) => m.role)).toStrictEqual(["user", "assistant"])
  })

  it("survives a half-flushed final line instead of losing the whole log", () => {
    // The harness may still hold the log open, so a truncated last line is
    // expected. Everything before it is intact and must still be recovered —
    // throwing here would turn a recoverable session into an unrecoverable one.
    const out = rebuildTranscript(
      "s1",
      [user([text("hi")]), assistant([text("hello")]), '{"type":"assistant","mess'].join("\n")
    )

    expect(out).toHaveLength(2)
  })

  it("drops empty thinking blocks rather than emitting blank reasoning parts", () => {
    // Claude's stored logs record thinking with an EMPTY string plus a signature,
    // so reasoning is genuinely unrecoverable. Emitting a part for it would put
    // empty "thought" bubbles through the whole rebuilt transcript.
    const out = rebuildTranscript(
      "s1",
      assistant([{ type: "thinking", thinking: "", signature: "abc" }, text("answer")])
    )

    expect(partTags(out[0]!)).toStrictEqual(["Text"])
  })

  it("returns nothing for an empty log rather than an empty turn", () => {
    expect(rebuildTranscript("s1", "")).toStrictEqual([])
    expect(rebuildTranscript("s1", "\n\n")).toStrictEqual([])
  })

  it("produces a transcript that decodes against the Message schema", async () => {
    // The load-bearing guarantee. `TranscriptStore.readAll` swallows a decode
    // failure and returns [], so an invalid rebuild is indistinguishable from the
    // data loss it was meant to repair.
    const out = rebuildTranscript(
      "s1",
      [
        user([text("do it")]),
        assistant([text("sure"), toolUse("t1", "Write", { file_path: "/tmp/a.ts" })]),
        user([toolResult("t1", "written")]),
        assistant([text("done")])
      ].join("\n")
    )

    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(Schema.Array(MessageSchema))(JSON.parse(JSON.stringify(out)))
    )
    // One prompt → one assistant turn: the tool_result line is mid-turn, so the
    // trailing "done" folds into the SAME assistant message rather than opening
    // a third.
    expect(decoded).toHaveLength(2)
    expect(decoded[1]!.parts.map((p) => p._tag)).toStrictEqual(["Text", "Tool", "Text"])
  })
})

describe("harnessLogPath", () => {
  it("maps a worktree path to Claude's project dir by replacing separators", () => {
    expect(harnessLogPath("/Users/me/starbase/worktrees/app/feat", "abc-123")).toMatch(
      /\.claude\/projects\/-Users-me-starbase-worktrees-app-feat\/abc-123\.jsonl$/
    )
  })
})
