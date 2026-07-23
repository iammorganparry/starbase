import type { Event, Part } from "@opencode-ai/sdk"
import { describe, expect, it } from "vitest"
import {
  asPermissionAsked,
  assistantText,
  createOpencodeMapper,
  mapOpencodeReasoning,
  mapOpencodePermission,
  opencodePromptBody,
  planTools,
  parseServerUrl,
  permissionToRequest,
  promptError,
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

describe("mapOpencodeReasoning", () => {
  it("leaves default unset and maps semantic strength to model variants", () => {
    expect(mapOpencodeReasoning(undefined)).toBeUndefined()
    expect(mapOpencodeReasoning("off")).toBe("minimal")
    expect(mapOpencodeReasoning("think")).toBe("medium")
    expect(mapOpencodeReasoning("think-hard")).toBe("high")
    expect(mapOpencodeReasoning("ultrathink")).toBe("xhigh")
  })
})

describe("opencodePromptBody", () => {
  it("carries the selected variant through the live request boundary", () => {
    expect(
      opencodePromptBody(
        { model: "openai/gpt-5", reasoningEffort: "ultrathink" },
        "Inspect the repository",
        false
      )
    ).toStrictEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "xhigh",
      parts: [{ type: "text", text: "Inspect the repository" }]
    })
  })

  it("leaves native reasoning untouched by default and confines planning prompts", () => {
    expect(opencodePromptBody({ model: null }, "Draft a plan", true)).toStrictEqual({
      tools: { edit: false, write: false, patch: false, task: false },
      parts: [{ type: "text", text: "Draft a plan" }]
    })
  })
})

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
   * `ask` is what routes an action onto opencode's permission bus and thus onto
   * Starbase's own `canUseTool`. Marking a mutating tool `allow` here would
   * bypass the session's HITL mode entirely.
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

  /**
   * Spawning a subagent isn't itself a mutation, and gating it buys nothing: the
   * child session's own edits and commands raise their own permissions and gate
   * under the same rules. Matches opencode's own default and Claude's adapter,
   * which never gates a `Task` — so a given mode feels the same on both.
   */
  it("does not gate a subagent spawn, whose own actions gate instead", () => {
    for (const mode of ["ask", "accept-edits", "plan", "auto"] as const) {
      expect(mapOpencodePermission(mode).task).toBe("allow")
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

  /**
   * Plan mode is confined per-PROMPT (`planTools`), not here. This map is baked
   * into the server's config when it spawns, and an approved plan has to gain
   * write access without restarting the server and re-attaching the session.
   */
  it("leaves plan mode to the per-prompt tool map, so approval can widen it", () => {
    expect(mapOpencodePermission("plan")).toStrictEqual(mapOpencodePermission("ask"))
  })
})

describe("planTools", () => {
  /**
   * Withholding beats gating: a gate asks the operator to approve an edit that
   * has not been planned yet — the exact decision plan mode exists to defer —
   * and an unanswered one parks the turn.
   */
  it("withholds every way of writing to the worktree", () => {
    expect(planTools.edit).toBe(false)
    expect(planTools.write).toBe(false)
    expect(planTools.patch).toBe(false)
  })

  /**
   * A subagent inherits none of this: it runs in a child session whose own edits
   * raise their own permissions, so a planner could otherwise spawn its way
   * straight around the restriction.
   */
  it("withholds task, which would otherwise be the way around it", () => {
    expect(planTools.task).toBe(false)
  })

  /**
   * Planning means READING the code. Claude's plan mode leaves Bash available
   * for exactly that (`agent-runner`'s `verdict` auto-allows commands under
   * `plan`), and Codex's `read-only` sandbox blocks writes, not commands.
   */
  it("leaves the research tools alone", () => {
    expect(planTools.bash).toBeUndefined()
    expect(planTools.read).toBeUndefined()
    expect(planTools.grep).toBeUndefined()
  })
})

describe("assistantText", () => {
  const text = (over: Record<string, unknown>) => ({ type: "text", ...over }) as unknown as Part

  it("joins the model's text parts in order", () => {
    expect(assistantText([text({ text: "Here is " }), text({ text: "the plan." })])).toBe(
      "Here is the plan."
    )
  })

  /**
   * The same filter `forPart` applies: `synthetic` parts are opencode's own
   * scaffolding (injected context), not the model talking. Letting them through
   * here would splice the harness's own boilerplate into a plan.
   */
  it("drops opencode's scaffolding", () => {
    expect(
      assistantText([text({ text: "ctx", synthetic: true }), text({ text: "real" }), text({ text: "x", ignored: true })])
    ).toBe("real")
  })

  it("survives a response with no parts at all", () => {
    expect(assistantText(undefined)).toBe("")
    expect(assistantText([])).toBe("")
  })
})

describe("createOpencodeMapper — plan-turn text suppression", () => {
  const SESSION = "ses_1"
  const part = (p: Record<string, unknown>) =>
    ({ type: "message.part.updated", properties: { part: { sessionID: SESSION, ...p } } }) as unknown as Event

  /**
   * A plan turn's whole reply IS the plan. Streaming it as chat text would show
   * the operator the same plan twice — once as an interactive card they can
   * comment on, once as inert markdown they can't.
   */
  it("holds the agent's prose back while a plan turn is in flight", () => {
    let planning = true
    const m = createOpencodeMapper(
      () => SESSION,
      () => planning
    )
    expect(m.apply(part({ id: "prt_1", messageID: "msg_a", type: "text", text: "the plan" }))).toStrictEqual([])
    // …and resumes the moment approval flips the flag, so the execution turn
    // that follows still narrates itself.
    planning = false
    expect(m.apply(part({ id: "prt_2", messageID: "msg_b", type: "text", text: "done" }))).toStrictEqual([
      { _tag: "Assistant", text: "done" }
    ])
  })

  it("suppresses nothing by default, so ordinary turns are untouched", () => {
    const m = createOpencodeMapper(() => SESSION)
    expect(m.apply(part({ id: "prt_1", messageID: "msg_a", type: "text", text: "hi" }))).toStrictEqual([
      { _tag: "Assistant", text: "hi" }
    ])
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

/**
 * The SDK reports a rejected prompt in `error` rather than throwing, so the
 * adapter has to check it: an unchecked `data?.info` turned a failed turn into a
 * `Done` with zero tokens — the run did nothing and claimed success. This is the
 * message the operator gets instead.
 */
describe("promptError", () => {
  it("prefers the payload's own message", () => {
    // Verbatim shape from a live server rejecting a foreign session id.
    expect(
      promptError({
        name: "UnknownError",
        data: { message: "Unexpected server error. Check server logs for details." }
      })
    ).toBe("Unexpected server error. Check server logs for details.")
  })

  it("falls back to the error's name, then to a plain statement", () => {
    expect(promptError({ name: "ProviderAuthError" })).toBe("ProviderAuthError")
    expect(promptError({})).toBe("opencode rejected the prompt")
    expect(promptError(undefined)).toBe("opencode rejected the prompt")
  })
})

describe("totalTokens", () => {
  /**
   * The runtime sends a `total`; the SDK's type doesn't declare one. Prefer it,
   * but fall back to the sum so a change on either side can't silently report 0.
  */
  it("prefers the runtime's total", () => {
    expect(totalTokens({ total: 36313, input: 34508, output: 4, reasoning: 9 })).toBe(36313)
  })

  it("falls back to the full context when total is absent", () => {
    expect(totalTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 400, write: 10 } })).toBe(520)
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
   * `"edit"` is the LOOSER kind, not the stricter one: `verdict` auto-allows it
   * under `accept-edits`, which is the default mode. So only opencode's own
   * `edit` may map to it — mapping the unknown there auto-approved a new upstream
   * permission kind for every default-mode session, without the operator ever
   * seeing it. An allowlist fails closed.
   */
  it("gates an unknown permission kind rather than auto-allowing it", () => {
    const request = permissionToRequest({ id: "per_3", sessionID: "ses_1", permission: "something_new" })
    expect(request.kind).toBe("command")
    expect(request.tool).toBe("something_new")
    expect(request.target).toBeNull()
    // No command → the gate offers no "Always allow", so it asks every time.
    expect(request.command).toBeNull()
  })

  /**
   * The one with teeth. Trusting edits to your WORKTREE (what `accept-edits`
   * means) is not trusting edits to your disk, so reaching outside it has to keep
   * gating in the default mode.
   */
  it("gates external_directory even under accept-edits", () => {
    const request = permissionToRequest({
      id: "per_4",
      sessionID: "ses_1",
      permission: "external_directory",
      patterns: ["/etc/hosts"],
      metadata: { filepath: "/etc/hosts" }
    })
    expect(request.kind).toBe("command")
    expect(request.target).toBe("/etc/hosts")
    // A path must never become an "Always allow" token — `isAllowlisted` prefix
    // matches, so one approval would whitelist a whole directory.
    expect(request.command).toBeNull()
  })

  it("gates opencode's doom_loop guard", () => {
    // Not in our config, so it keeps opencode's own `ask` default and lands here.
    expect(permissionToRequest({ id: "per_5", sessionID: "ses_1", permission: "doom_loop" }).kind).toBe(
      "command"
    )
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

  /**
   * opencode's `task` tool runs its subagent in a CHILD session with its own id,
   * so everything it does arrives under an id that isn't the run's. Filtering on
   * the run's session made the subagent's entire contribution invisible.
   *
   * Fixtures below are verbatim from a live 1.18 server.
   */
  describe("subagents (task → child session)", () => {
    const CHILD = "ses_child"
    const created = (id: string, parentID: string, agent = "general", title = "Do a thing") =>
      ev({ type: "session.created", properties: { info: { id, parentID, agent, title } } })

    const childPart = (p: Record<string, unknown>) =>
      ev({ type: "message.part.updated", properties: { part: { sessionID: CHILD, ...p } } })

    it("opens a tab when the run spawns a subagent", () => {
      const m = mapper()
      expect(m.apply(created(CHILD, SESSION))).toStrictEqual([
        {
          _tag: "SubagentStarted",
          id: CHILD,
          name: "general",
          description: "Do a thing",
          // Spawned by the RUN itself, so it's a top-level tab.
          parentId: null
        }
      ])
    })

    /** The bug: a subagent's work arrived under the child id and was dropped. */
    it("attributes the subagent's work to it rather than dropping it", () => {
      const m = mapper()
      m.apply(created(CHILD, SESSION))
      expect(
        m.apply(childPart({ id: "prt_c", messageID: "msg_c", type: "text", text: "done" }))
      ).toStrictEqual([{ _tag: "Assistant", text: "done", agentId: CHILD }])

      expect(
        m.apply(
          childPart({
            id: "prt_t",
            messageID: "msg_c",
            type: "tool",
            callID: "call_c",
            tool: "write",
            state: { status: "running", input: { filePath: "/tmp/sub.txt" }, time: { start: 1 } }
          })
        )
      ).toStrictEqual([
        { _tag: "ToolStart", id: "call_c", name: "Write", target: "/tmp/sub.txt", agentId: CHILD }
      ])
    })

    it("nests a subagent spawned BY a subagent under it", () => {
      const m = mapper()
      m.apply(created(CHILD, SESSION))
      expect(m.apply(created("ses_grandchild", CHILD))).toStrictEqual([
        {
          _tag: "SubagentStarted",
          id: "ses_grandchild",
          name: "general",
          description: "Do a thing",
          // Parented to the sub-agent that spawned it, not the run.
          parentId: CHILD
        }
      ])
    })

    /** A child's idle IS its end — unlike the run's, which is not the turn's. */
    it("closes the tab when the subagent goes idle", () => {
      const m = mapper()
      m.apply(created(CHILD, SESSION))
      expect(m.apply(ev({ type: "session.idle", properties: { sessionID: CHILD } }))).toStrictEqual([
        { _tag: "SubagentEnded", id: CHILD, status: "done" }
      ])
      // …while the run's own idle still says nothing (Done comes from the prompt).
      expect(m.apply(ev({ type: "session.idle", properties: { sessionID: SESSION } }))).toStrictEqual(
        []
      )
    })

    it("ends the subagent's tab on its error, rather than failing the turn", () => {
      const m = mapper()
      m.apply(created(CHILD, SESSION))
      expect(
        m.apply(
          ev({
            type: "session.error",
            properties: { sessionID: CHILD, error: { name: "UnknownError" } }
          })
        )
      ).toStrictEqual([{ _tag: "SubagentEnded", id: CHILD, status: "error" }])
    })

    /** The readout is the TURN's; a subagent's steps roll up into the parent. */
    it("counts only the run's own tokens", () => {
      const m = mapper()
      m.apply(created(CHILD, SESSION))
      expect(
        m.apply(
          childPart({
            id: "prt_s",
            messageID: "msg_c",
            type: "step-finish",
            reason: "stop",
            cost: 1,
            tokens: { total: 999, input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          })
        )
      ).toStrictEqual([])
    })

    it("ignores a session that didn't descend from this run", () => {
      const m = mapper()
      expect(m.apply(created("ses_stranger", "ses_unrelated"))).toStrictEqual([])
    })
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

  it("streams a running command's partial output as a ToolDelta when opencode exposes it", () => {
    const m = mapper()
    const running = (output: string) =>
      part({
        id: "prt_b",
        messageID: "msg_b",
        type: "tool",
        callID: "call_b",
        tool: "bash",
        state: { status: "running", input: { command: "pnpm test" }, metadata: { output }, time: { start: 1 } }
      })
    // First sighting: the ToolStart plus the first slice of live output.
    expect(m.apply(running("RUN  v2\n"))).toStrictEqual([
      { _tag: "ToolStart", id: "call_b", name: "Bash", target: "pnpm test" },
      { _tag: "ToolDelta", id: "call_b", output: "RUN  v2\n" }
    ])
    // Grown output → another delta; the card was already opened, so no ToolStart.
    expect(m.apply(running("RUN  v2\n ✓ a\n"))).toStrictEqual([
      { _tag: "ToolDelta", id: "call_b", output: "RUN  v2\n ✓ a\n" }
    ])
    // An update that didn't grow the output is silent — no duplicate delta.
    expect(m.apply(running("RUN  v2\n ✓ a\n"))).toStrictEqual([])
  })

  it("says nothing live when a running tool exposes no partial output", () => {
    const m = mapper()
    const running = part({
      id: "prt_c",
      messageID: "msg_c",
      type: "tool",
      callID: "call_c",
      tool: "bash",
      state: { status: "running", input: { command: "sleep 1" }, time: { start: 1 } }
    })
    // No metadata output → just the ToolStart, output arrives whole on completion.
    expect(m.apply(running)).toStrictEqual([{ _tag: "ToolStart", id: "call_c", name: "Bash", target: "sleep 1" }])
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

  it("reports the latest step's context instead of adding contexts together", () => {
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
    expect(m.apply(step(50))).toStrictEqual([{ _tag: "Usage", tokens: 50 }])
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
