import type { Event } from "@opencode-ai/sdk"
import { describe, expect, it } from "vitest"
import {
  asPermissionAsked,
  createOpencodeMapper,
  mapOpencodePermission,
  parseServerUrl,
  permissionToRequest,
  splitModelId,
  toolTarget,
  totalTokens
} from "./opencode-adapter.js"

/**
 * opencode's live path needs a real server + credentials, so we test the PURE
 * seams: the model-id split, the mode→permission map, the URL parse, and the
 * event fold the transcript/tool-cards/Done depend on. The process + SSE wiring
 * is verified live and by the e2e shim.
 *
 * Every fixture below is a VERBATIM capture from a real opencode 1.18 server
 * (`opencode serve` + `GET /event`), not a guess from the SDK's types — which
 * are stale in exactly the places that matter (see `PermissionAsked`).
 */

const ev = (e: unknown): Event => e as Event

describe("splitModelId", () => {
  /**
   * The one that bites: OpenRouter model ids contain slashes, so only the FIRST
   * separates provider from model. A naive `split("/")` mangles every one of the
   * ~342 models a single OpenRouter key unlocks.
   */
  it("splits a three-segment OpenRouter id on the first slash only", () => {
    expect(splitModelId("openrouter/anthropic/claude-opus-4.5")).toStrictEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-opus-4.5"
    })
  })

  it("splits an ordinary two-segment id", () => {
    expect(splitModelId("opencode/big-pickle")).toStrictEqual({
      providerID: "opencode",
      modelID: "big-pickle"
    })
  })

  it("treats a bare id as a provider with no model", () => {
    expect(splitModelId("anthropic")).toStrictEqual({ providerID: "anthropic", modelID: "" })
  })
})

describe("mapOpencodePermission", () => {
  /**
   * Anything the operator might want to gate must be `ask`, because `ask` is what
   * routes an action onto opencode's permission bus and thus onto Starbase's own
   * `canUseTool`. Marking these `allow` here would silently bypass the session's
   * HITL mode entirely.
   */
  it("routes mutating tools to the bus for every mode except auto", () => {
    for (const mode of ["ask", "accept-edits", "plan"] as const) {
      const permission = mapOpencodePermission(mode)
      expect(permission.edit).toBe("ask")
      expect(permission.bash).toBe("ask")
      // Reads are never gated — they can't change anything and gating them would
      // make every run a click-fest.
      expect(permission.read).toBe("allow")
    }
  })

  it("lets auto bypass the operator", () => {
    const permission = mapOpencodePermission("auto")
    expect(permission.edit).toBe("allow")
    expect(permission.bash).toBe("allow")
  })

  /**
   * `read-only` has to be enforced at the HARNESS, not left to `canUseTool`: a
   * mutating tool that never raises a permission would sail straight past the
   * callback. This is the adversarial reviewer's only real protection.
   */
  it("read-only denies mutation in every mode, including auto", () => {
    for (const mode of ["ask", "accept-edits", "plan", "auto"] as const) {
      const permission = mapOpencodePermission(mode, true)
      expect(permission.edit).toBe("deny")
      expect(permission.bash).toBe("deny")
      expect(permission.task).toBe("deny")
      expect(permission.external_directory).toBe("deny")
      // …but reading is the whole job of a reviewer.
      expect(permission.read).toBe("allow")
    }
  })

  /**
   * opencode defaults `external_directory` to `ask`. Left unset, the first time
   * an agent looks outside the worktree it raises a permission nobody answers and
   * the headless run deadlocks. We always pin it.
   */
  it("always pins external_directory rather than leaving it defaulted", () => {
    expect(mapOpencodePermission("auto").external_directory).toBe("allow")
    expect(mapOpencodePermission("ask").external_directory).toBe("ask")
  })
})

describe("parseServerUrl", () => {
  it("reads the url out of the server's banner", () => {
    expect(parseServerUrl("opencode server listening on http://127.0.0.1:57611\n")).toBe(
      "http://127.0.0.1:57611"
    )
  })

  it("is null until the banner arrives, so a partial chunk isn't mistaken for readiness", () => {
    expect(parseServerUrl("")).toBeNull()
    expect(parseServerUrl("opencode server listen")).toBeNull()
  })
})

describe("totalTokens", () => {
  /**
   * The runtime sends a `total`; the SDK's type doesn't declare one. Prefer it,
   * but fall back to the sum so a change on either side can't silently report 0.
   */
  it("prefers the runtime's total", () => {
    expect(totalTokens({ total: 36313, input: 34508, output: 4, reasoning: 9 } as never)).toBe(36313)
  })

  it("falls back to the sum when total is absent", () => {
    expect(totalTokens({ input: 100, output: 20, reasoning: 5 })).toBe(125)
  })
})

describe("toolTarget", () => {
  it("digs each tool's principal argument out of its input", () => {
    expect(toolTarget("bash", { command: "npm test" })).toBe("npm test")
    expect(toolTarget("write", { filePath: "/tmp/hello.txt" })).toBe("/tmp/hello.txt")
    expect(toolTarget("grep", { pattern: "TODO" })).toBe("TODO")
    expect(toolTarget("webfetch", { url: "https://example.com" })).toBe("https://example.com")
  })

  it("is null for an unknown tool or absent input", () => {
    expect(toolTarget("mystery", { thing: "x" })).toBeNull()
    expect(toolTarget("bash", undefined)).toBeNull()
  })
})

describe("asPermissionAsked", () => {
  /**
   * VERBATIM from a live 1.18 server. The SDK declares `permission.updated` with
   * `{ type, pattern, title, callID }` — none of which is what actually arrives.
   * Matching the SDK's shape means never seeing a permission, which hangs the
   * agent forever. This fixture is the regression guard for that.
   */
  const real = {
    type: "permission.asked",
    properties: {
      id: "per_f6ede09e1001JWMvh8xW8aLQ9x",
      sessionID: "ses_091220df9ffe2bpl6Y4YwW89Za",
      permission: "edit",
      patterns: ["hello.txt"],
      metadata: {
        filepath: "/tmp/oc/hello.txt",
        diff: "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+hi\n"
      },
      always: ["*"],
      tool: { messageID: "msg_f6eddf2ac001m0UXx2dRtdBxGX", callID: "call_614bcbf6d2884d618a732b64" }
    }
  }

  it("recognises the event the server really emits", () => {
    const asked = asPermissionAsked(real)
    expect(asked).not.toBeNull()
    expect(asked?.id).toBe("per_f6ede09e1001JWMvh8xW8aLQ9x")
    expect(asked?.permission).toBe("edit")
  })

  it("ignores the SDK's documented-but-unreal permission.updated", () => {
    expect(
      asPermissionAsked({
        type: "permission.updated",
        properties: { id: "per_1", sessionID: "ses_1", type: "edit", title: "Edit hello.txt" }
      })
    ).toBeNull()
  })

  it("ignores other events and malformed junk rather than throwing", () => {
    expect(asPermissionAsked({ type: "session.idle", properties: { sessionID: "ses_1" } })).toBeNull()
    expect(asPermissionAsked({ type: "permission.asked" })).toBeNull()
    expect(asPermissionAsked({ type: "permission.asked", properties: { id: 42 } })).toBeNull()
    expect(asPermissionAsked(null)).toBeNull()
    expect(asPermissionAsked("nonsense")).toBeNull()
  })
})

describe("permissionToRequest", () => {
  it("maps an edit permission, taking the subject from its pattern", () => {
    expect(
      permissionToRequest({
        id: "per_1",
        sessionID: "ses_1",
        permission: "edit",
        patterns: ["hello.txt"],
        metadata: { filepath: "/tmp/oc/hello.txt" }
      })
    ).toStrictEqual({ kind: "edit", tool: "Edit", target: "hello.txt", command: null })
  })

  it("maps a bash permission to a command, carrying the command through", () => {
    expect(
      permissionToRequest({
        id: "per_2",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "npm test -- billing" }
      })
    ).toStrictEqual({
      kind: "command",
      tool: "Bash",
      target: "npm test -- billing",
      command: "npm test -- billing"
    })
  })

  /**
   * Unknown permission kinds must gate as `edit` — the stricter of the two. A new
   * upstream permission type should fail closed, not sail through ungated.
   */
  it("treats an unknown permission kind as an edit", () => {
    const request = permissionToRequest({ id: "per_3", sessionID: "ses_1", permission: "something_new" })
    expect(request.kind).toBe("edit")
    expect(request.tool).toBe("something_new")
    expect(request.target).toBeNull()
  })
})

describe("createOpencodeMapper", () => {
  const SESSION = "ses_1"
  const mapper = () => createOpencodeMapper(() => SESSION)

  const part = (p: Record<string, unknown>) =>
    ev({ type: "message.part.updated", properties: { part: { sessionID: SESSION, ...p } } })

  const userMessage = (id: string) =>
    ev({ type: "message.updated", properties: { info: { id, role: "user", sessionID: SESSION } } })

  /**
   * opencode re-sends a part's FULL text on each update, but `applyStreamEvent`
   * APPENDS. Emitting `part.text` verbatim would render "pong" as "ppopon…".
   */
  it("emits only the new suffix of a growing text part", () => {
    const m = mapper()
    expect(m.apply(part({ id: "prt_1", messageID: "msg_a", type: "text", text: "po" }))).toStrictEqual([
      { _tag: "Assistant", text: "po" }
    ])
    expect(m.apply(part({ id: "prt_1", messageID: "msg_a", type: "text", text: "pong" }))).toStrictEqual([
      { _tag: "Assistant", text: "ng" }
    ])
    // A repeat with nothing new must stay silent, not re-emit.
    expect(m.apply(part({ id: "prt_1", messageID: "msg_a", type: "text", text: "pong" }))).toStrictEqual([])
  })

  /**
   * The bus carries the operator's OWN message parts. Without this filter the
   * prompt is echoed straight back into the transcript as if the agent said it.
   */
  it("does not echo the operator's own prompt back as assistant text", () => {
    const m = mapper()
    m.apply(userMessage("msg_user"))
    expect(
      m.apply(part({ id: "prt_0", messageID: "msg_user", type: "text", text: "Say pong." }))
    ).toStrictEqual([])
    // …while the assistant's reply still comes through.
    expect(m.apply(part({ id: "prt_1", messageID: "msg_a", type: "text", text: "pong" }))).toStrictEqual([
      { _tag: "Assistant", text: "pong" }
    ])
  })

  it("drops opencode's synthetic scaffolding parts", () => {
    const m = mapper()
    expect(
      m.apply(part({ id: "prt_s", messageID: "msg_a", type: "text", text: "<context>", synthetic: true }))
    ).toStrictEqual([])
  })

  it("ignores parts belonging to another session on the shared bus", () => {
    const m = mapper()
    expect(
      m.apply(
        ev({
          type: "message.part.updated",
          properties: {
            part: { sessionID: "ses_other", id: "prt_x", messageID: "msg_x", type: "text", text: "hi" }
          }
        })
      )
    ).toStrictEqual([])
  })

  it("streams reasoning as Thinking and closes it when the part completes", () => {
    const m = mapper()
    expect(
      m.apply(part({ id: "prt_r", messageID: "msg_a", type: "reasoning", text: "Think", time: { start: 1000 } }))
    ).toStrictEqual([{ _tag: "Thinking", text: "Think", seconds: null, done: false }])

    // Completing with no new text must STILL emit, or the part spins forever.
    expect(
      m.apply(
        part({
          id: "prt_r",
          messageID: "msg_a",
          type: "reasoning",
          text: "Think",
          time: { start: 1000, end: 4000 }
        })
      )
    ).toStrictEqual([{ _tag: "Thinking", text: "", seconds: 3, done: true }])
  })

  it("opens a tool card once and closes it on completion", () => {
    const m = mapper()
    const running = part({
      id: "prt_t",
      messageID: "msg_a",
      type: "tool",
      callID: "call_1",
      tool: "write",
      state: { status: "running", input: { filePath: "/tmp/hello.txt" }, time: { start: 1 } }
    })
    expect(m.apply(running)).toStrictEqual([
      { _tag: "ToolStart", id: "call_1", name: "Write", target: "/tmp/hello.txt" }
    ])
    // A second `running` update must not re-open the card.
    expect(m.apply(running)).toStrictEqual([])

    expect(
      m.apply(
        part({
          id: "prt_t",
          messageID: "msg_a",
          type: "tool",
          callID: "call_1",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "/tmp/hello.txt" },
            output: "wrote 1 line",
            title: "hello.txt",
            metadata: {},
            time: { start: 1, end: 2 }
          }
        })
      )
    ).toStrictEqual([
      { _tag: "ToolEnd", id: "call_1", status: "success", meta: "hello.txt", diff: null, preview: "wrote 1 line" }
    ])
  })

  it("emits a ToolStart even when the first sighting of a call is its failure", () => {
    // A denied permission surfaces as a straight-to-error tool: without the
    // synthesized start there'd be a ToolEnd for a card that never opened.
    const m = mapper()
    expect(
      m.apply(
        part({
          id: "prt_t",
          messageID: "msg_a",
          type: "tool",
          callID: "call_2",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "rm -rf /" },
            error: "permission denied",
            time: { start: 1, end: 2 }
          }
        })
      )
    ).toStrictEqual([
      { _tag: "ToolStart", id: "call_2", name: "Bash", target: "rm -rf /" },
      { _tag: "ToolEnd", id: "call_2", status: "error", meta: "permission denied", diff: null, preview: null }
    ])
  })

  it("accumulates a running token count across steps", () => {
    const m = mapper()
    const step = (total: number) =>
      part({
        id: `prt_s${total}`,
        messageID: "msg_a",
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { total, input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    expect(m.apply(step(100))).toStrictEqual([{ _tag: "Usage", tokens: 100 }])
    expect(m.apply(step(50))).toStrictEqual([{ _tag: "Usage", tokens: 150 }])
  })

  /**
   * `Done` is deliberately NOT derived from `session.idle`: idle lands after
   * `session.prompt` has already resolved and the adapter has torn the stream
   * down, so a Done wired to it would never be emitted. The prompt's response is
   * the source of truth (see `driveOpencode`).
   */
  it("does not emit Done from session.idle", () => {
    const m = mapper()
    expect(m.apply(ev({ type: "session.idle", properties: { sessionID: SESSION } }))).toStrictEqual([])
  })

  it("surfaces a session error as Failed", () => {
    const m = mapper()
    expect(
      m.apply(
        ev({
          type: "session.error",
          properties: {
            sessionID: SESSION,
            error: { name: "ProviderAuthError", data: { message: "missing api key" } }
          }
        })
      )
    ).toStrictEqual([{ _tag: "Failed", message: "missing api key" }])
  })

  it("falls back to the error name when it carries no message", () => {
    const m = mapper()
    expect(
      m.apply(ev({ type: "session.error", properties: { sessionID: SESSION, error: { name: "UnknownError" } } }))
    ).toStrictEqual([{ _tag: "Failed", message: "UnknownError" }])
  })
})
