import type { PermissionMode, StreamEvent } from "@starbase/core"
import { CliExecError } from "@starbase/core"
import type { Event, Part } from "@opencode-ai/sdk"
import { Effect, Runtime } from "effect"
import type { AgentContext, PermissionRequest, SessionSpec } from "./adapter.js"
import { capOutput } from "./output-cap.js"

/**
 * Real opencode harness, driven by `@opencode-ai/sdk`'s CLIENT against a server
 * we spawn ourselves.
 *
 * We deliberately do NOT use the SDK's `createOpencodeServer`. It does
 * `spawn("opencode", …)` — a bare name resolved off `PATH`, with no executable
 * override in `ServerOptions` (contrast Claude's `pathToClaudeCodeExecutable`
 * and Codex's `codexPathOverride`). Two problems: Starbase's whole discovery
 * model hands the adapter a resolved `binPath`, and an Electron GUI app on macOS
 * doesn't inherit the shell `PATH`, so a user whose opencode lives in
 * `~/.opencode/bin` would silently get "not found". It also *overwrites*
 * `OPENCODE_CONFIG_CONTENT` with its own `config`, clobbering our injection.
 * So: spawn `<binPath> serve` here, parse the URL it prints, and use the SDK
 * purely as a typed client.
 *
 * Unlike Codex, opencode has a real permission loop: the server raises
 * `permission.asked` on its event bus and we reply on a separate endpoint. It is
 * asynchronous request/reply rather than Claude's synchronous `canUseTool`
 * callback, so `runOpencode` bridges the two (see `PermissionBridge`). Note the
 * SDK's types do NOT describe that event correctly — see `PermissionAsked`.
 *
 * The event→`StreamEvent` mapping and the policy/model helpers are pure and
 * unit-tested; `runOpencode` is verified live and via the e2e shim.
 */

// ── Pure helpers (the testable seam) ─────────────────────────────────────────

/**
 * Split an opencode model id into the `{providerID, modelID}` pair its API
 * wants. Only the FIRST slash separates them: the provider id never contains a
 * slash but the model id routinely does — `openrouter/anthropic/claude-opus-4.5`
 * is provider `openrouter`, model `anthropic/claude-opus-4.5`. A naive
 * `split("/")` silently mangles every OpenRouter model.
 */
export const splitModelId = (id: string): { providerID: string; modelID: string } => {
  const i = id.indexOf("/")
  return i === -1
    ? { providerID: id, modelID: "" }
    : { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}

/**
 * opencode's permission config for a run. Values are `"ask" | "allow" | "deny"`.
 *
 * `ask` routes the action to opencode's permission bus, which we bridge onto
 * `ctx.canUseTool` — so Starbase's own HITL mode/allowlist decides. `auto` skips
 * the bus entirely.
 *
 * "Ask about everything the operator might want to gate" is NOT the rule: the
 * bridge only understands two kinds of request, and what it does with them
 * depends on the mode. Routing a kind it can't meaningfully classify to it just
 * moves the decision somewhere that can't make it (see `permissionToRequest`).
 * So a permission is only put on the bus when gating it actually means
 * something.
 *
 * `readOnly` must be enforced HERE rather than trusted to the bridge: the
 * adversarial reviewer denies everything through `canUseTool`, but a tool that
 * never raises a permission would sail past it. Denying the mutating tools at
 * the harness is the guarantee.
 *
 * `external_directory` is always pinned: it defaults to `ask` in opencode, and
 * an unanswered ask deadlocks a headless run the moment the agent looks outside
 * the worktree. We route it through the bridge like everything else — and unlike
 * an in-worktree edit, it keeps gating under `accept-edits`, because trusting
 * edits to your worktree is not the same as trusting edits to your disk.
 *
 * Anything NOT named here keeps opencode's own default — notably `doom_loop`,
 * which defaults to `ask` and so reaches the bridge, where it gates.
 */
export const mapOpencodePermission = (
  mode: PermissionMode,
  readOnly = false
): Record<string, "ask" | "allow" | "deny"> => {
  if (readOnly) {
    return {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      webfetch: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
      external_directory: "deny"
    }
  }
  // `auto` is the only mode that bypasses the operator entirely; every other
  // mode defers to the bridge, which applies the session's mode + allowlist.
  const gate = mode === "auto" ? "allow" : "ask"
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    webfetch: "allow",
    edit: gate,
    bash: gate,
    // Spawning a subagent is not itself a mutation, and gating it buys nothing:
    // the subagent runs in a child session whose OWN edits and commands raise
    // their own permissions and gate under the same rules (verified live). This
    // matches both opencode's own default for `task` and Claude's adapter, which
    // never gates a `Task` — so the two harnesses behave alike in a given mode
    // rather than opencode nagging about work Claude does silently.
    task: "allow",
    external_directory: gate
  }
}

/**
 * opencode tool names are lowercase (`bash`, `edit`); Starbase's transcript UI
 * speaks the Claude-flavoured title-case vocabulary that the other adapters emit
 * (`Bash`, `Edit`). Unknown tools pass through unchanged rather than being
 * dropped — an unrecognised tool should still be visible in the transcript.
 */
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  list: "List",
  patch: "Edit",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  skill: "Skill"
}

export const toolDisplayName = (tool: string): string => TOOL_NAMES[tool] ?? tool

/**
 * The most useful one-line subject for a tool call, dug out of its input. Each
 * opencode tool names its principal argument differently, and the transcript
 * shows this next to the tool name.
 */
export const toolTarget = (tool: string, input: Record<string, unknown> | undefined): string | null => {
  if (input === undefined) return null
  const pick = (key: string): string | null => {
    const value = input[key]
    return typeof value === "string" && value.length > 0 ? value : null
  }
  switch (tool) {
    case "bash":
      return pick("command")
    case "edit":
    case "write":
    case "read":
    case "patch":
      return pick("filePath") ?? pick("path")
    case "grep":
    case "glob":
      return pick("pattern")
    case "list":
      return pick("path")
    case "webfetch":
      return pick("url")
    case "websearch":
      return pick("query")
    case "task":
      return pick("description")
    case "skill":
      return pick("name")
    default:
      return null
  }
}

/**
 * The `permission.asked` event as the SERVER actually emits it.
 *
 * The SDK's types are STALE here and cannot be used: `@opencode-ai/sdk`'s `Event`
 * union declares `permission.updated` carrying a `Permission { type, pattern,
 * title, callID, … }`, but a live 1.18 server emits `permission.asked` with a
 * different shape entirely — `permission` (not `type`), `patterns` (not
 * `pattern`), a nested `tool: { messageID, callID }`, and NO `title`. Matching
 * the SDK's `Event` union therefore never fires and the agent hangs forever
 * waiting for a reply to a permission we never saw.
 *
 * Verified against the server's own OpenAPI (`GET /doc` → `EventPermissionAsked`)
 * and a live run. Declared locally, and parsed defensively, so a further upstream
 * shift degrades into "no permission seen" rather than a crash. The reply
 * endpoint (`POST /session/{id}/permissions/{permissionID}`) is still exactly
 * what the SDK describes, so the client method is used for that.
 */
export interface PermissionAsked {
  readonly id: string
  readonly sessionID: string
  /** The permission kind — a tool id ("edit", "bash", "task", …). */
  readonly permission: string
  /** What the action touches, e.g. `["hello.txt"]`. */
  readonly patterns?: ReadonlyArray<string>
  /** Tool-specific detail: `{ filepath, diff }` for edits, `{ command }` for bash. */
  readonly metadata?: Record<string, unknown>
  readonly tool?: { readonly messageID: string; readonly callID: string }
}

/** Narrow a bus event to a `permission.asked`, or null if it isn't one. */
export const asPermissionAsked = (event: unknown): PermissionAsked | null => {
  if (typeof event !== "object" || event === null) return null
  const { type, properties } = event as { type?: unknown; properties?: unknown }
  if (type !== "permission.asked") return null
  if (typeof properties !== "object" || properties === null) return null
  const p = properties as Record<string, unknown>
  if (typeof p.id !== "string" || typeof p.sessionID !== "string" || typeof p.permission !== "string") {
    return null
  }
  return p as unknown as PermissionAsked
}

/**
 * Map a `permission.asked` onto the request Starbase gates on.
 *
 * The kind is an ALLOWLIST, and that is the whole point: only opencode's own
 * `edit` maps to our `"edit"`.
 *
 * `"edit"` is not the stricter kind, it is the LOOSER one — `verdict` in
 * `agent-runner` auto-allows it under `accept-edits`, which is the default mode
 * (`EXEC_FALLBACK`, `DEFAULT_PROVIDER`). That is deliberate for real edits:
 * "accept edits" means "I trust you to change files in my worktree". It is
 * exactly wrong for anything else.
 *
 * So a denylist (`bash` → command, else edit) fails OPEN: `external_directory`
 * — the agent reaching OUTSIDE the worktree — and any permission kind opencode
 * adds upstream would be silently auto-approved for every default-mode session,
 * never reaching the operator at all. Mapping the unknown to `"command"` makes
 * it gate, so a new upstream kind fails closed and shows up as a prompt rather
 * than as a thing that already happened.
 */
export const permissionToRequest = (asked: PermissionAsked): PermissionRequest => {
  const metadata = asked.metadata ?? {}
  const str = (key: string): string | null => {
    const value = metadata[key]
    return typeof value === "string" && value.length > 0 ? value : null
  }
  const command = str("command")
  return {
    kind: asked.permission === "edit" ? "edit" : "command",
    tool: toolDisplayName(asked.permission),
    // There's no `title` on the real event, so build the subject from what's
    // there: the pattern it matched, else the concrete path/command.
    target: asked.patterns?.[0] ?? str("filepath") ?? str("filePath") ?? command,
    // ONLY a real shell command may carry one. The gate offers "Always allow
    // <first two words>" off this field and `isAllowlisted` PREFIX-matches it,
    // so handing it a path would let one approval whitelist a whole directory.
    command: asked.permission === "bash" ? command : null
  }
}

/**
 * A human message from one of opencode's error payloads.
 *
 * The union's members all carry a `name` and most a `data.message`, but the
 * shape is provider-dependent — read it defensively rather than switch on every
 * tag and go stale (the same reasoning the mapper's `session.error` uses).
 */
export const promptError = (error: unknown): string => {
  const e = (error ?? {}) as { name?: unknown; data?: { message?: unknown } }
  const message = typeof e.data?.message === "string" ? e.data.message : null
  const name = typeof e.name === "string" ? e.name : null
  return message ?? name ?? "opencode rejected the prompt"
}

/**
 * Total tokens for a finished turn. opencode's runtime reports a `total`, but the
 * SDK's type doesn't declare one — read it when present and fall back to the sum
 * so this can't silently report 0 if either side changes.
 */
export const totalTokens = (tokens: {
  input: number
  output: number
  reasoning: number
  cache?: { read: number; write: number }
}): number => {
  const declared = (tokens as { total?: unknown }).total
  return typeof declared === "number" ? declared : tokens.input + tokens.output + tokens.reasoning
}

/**
 * Folds opencode's event bus into Starbase's normalized `StreamEvent`s.
 *
 * Stateful by necessity, hence a factory rather than the pure function the other
 * adapters use, for two reasons found by driving the real binary:
 *
 *  - `Assistant`/`Thinking` APPEND downstream (`applyStreamEvent` does
 *    `last.text + e.text`), but opencode re-sends each part's FULL text on every
 *    `message.part.updated`. Emitting `part.text` would duplicate the message
 *    geometrically, so we track how much of each part we've emitted and send only
 *    the new suffix. (There are separate `message.part.delta` events, but a part
 *    can update without one — the suffix rule covers both.)
 *  - The bus carries the USER's message parts too, so a naive mapping echoes the
 *    operator's own prompt back as assistant text. We therefore skip parts
 *    belonging to a known user message. It has to be a user-denylist rather than
 *    an assistant-allowlist: `message.updated` for the *user* arrives before its
 *    parts, but for the *assistant* it arrives AFTER them — an allowlist would
 *    drop the reply.
 *  - The `task` tool runs its subagent in a CHILD session, so that work arrives
 *    under an id that is not the run's. We track the lineage from
 *    `session.created` and attribute it, rather than filtering by session id —
 *    which would render a subagent's entire contribution invisible.
 *
 * `Done` is NOT emitted from `session.idle`: that fires after `session.prompt`
 * has already resolved, so the turn is over before it lands. The prompt's own
 * response carries the authoritative cost/tokens instead (see `driveOpencode`).
 * A CHILD's idle is a different thing entirely — that subagent finishing.
 */
export interface OpencodeMapper {
  readonly apply: (event: Event) => ReadonlyArray<StreamEvent>
}

export const createOpencodeMapper = (opencodeSessionId: () => string | null): OpencodeMapper => {
  /** partID → characters already emitted, so we only ever send the suffix. */
  const emitted = new Map<string, number>()
  /** callID → true once ToolStart is out, so `running` updates don't re-open it. */
  const started = new Set<string>()
  /** callID → length of the live output last streamed, so we don't re-send an unchanged snapshot. */
  const streamedLen = new Map<string, number>()
  /** messageIDs known to be the operator's — their parts are not the agent talking. */
  const userMessages = new Set<string>()
  /**
   * Sub-session id → the session that spawned it. opencode's `task` tool runs a
   * subagent in a CHILD session with its own id, so its work arrives under an id
   * that isn't the run's. Tracked from `session.created`, which carries the
   * lineage (`parentID`) and the agent's identity (`agent`, `title`).
   */
  const subagents = new Map<string, string>()
  let tokens = 0

  /**
   * Which agent a session's output belongs to — undefined for the run itself,
   * else the sub-session's own id, used verbatim as the `agentId`.
   *
   * Session id plays the role Claude's `tool_use id` plays in its adapter: a
   * stable, unique handle for one agent's output at any depth. An id we haven't
   * been introduced to falls back to the main transcript — the server is private
   * to this run, so it IS ours, and showing it unattributed beats dropping it.
   */
  const agentOf = (sessionID: string): string | undefined =>
    sessionID !== opencodeSessionId() && subagents.has(sessionID) ? sessionID : undefined

  /**
   * A running tool's partial output, if opencode is exposing any.
   *
   * `ToolStateRunning.metadata` is untyped (`Record<string, unknown>`) and the
   * SDK promises no partial-output field, but opencode's shell tool has grown a
   * `metadata.output` (or `stdout`) string as a command runs. Read it defensively:
   * when it's there, we stream it live; when it isn't, this returns null and
   * output simply arrives whole on completion — no worse than before.
   */
  const runningOutput = (metadata: Record<string, unknown> | undefined): string | null => {
    if (metadata === undefined) return null
    const raw = metadata.output ?? metadata.stdout
    return typeof raw === "string" && raw.length > 0 ? raw : null
  }

  /** The unsent tail of a streaming text/reasoning part. */
  const suffix = (partId: string, full: string): string => {
    const already = emitted.get(partId) ?? 0
    if (full.length <= already) return ""
    emitted.set(partId, full.length)
    return full.slice(already)
  }

  const forPart = (part: Part): ReadonlyArray<StreamEvent> => {
    // Stamp every content event with the agent that produced it, so a subagent's
    // work lands in its own tab rather than being spliced into the main turn.
    const agentId = agentOf(part.sessionID)
    const forAgent = agentId === undefined ? {} : { agentId }
    switch (part.type) {
      case "text": {
        // `synthetic` parts are opencode's own scaffolding (e.g. injected
        // context), not the model talking — showing them would confuse.
        if (part.synthetic === true || part.ignored === true) return []
        const text = suffix(part.id, part.text)
        return text.length === 0 ? [] : [{ _tag: "Assistant", text, ...forAgent }]
      }

      case "reasoning": {
        const text = suffix(part.id, part.text)
        const done = part.time.end !== undefined
        // A completed reasoning part with nothing new still has to close the
        // streaming part downstream, or it stays spinning forever.
        if (text.length === 0 && !done) return []
        const seconds =
          part.time.end === undefined ? null : Math.round((part.time.end - part.time.start) / 1000)
        return [{ _tag: "Thinking", text, seconds, done, ...forAgent }]
      }

      case "tool": {
        const name = toolDisplayName(part.tool)
        const state = part.state
        if (state.status === "running" || state.status === "completed" || state.status === "error") {
          const events: Array<StreamEvent> = []
          if (!started.has(part.callID)) {
            started.add(part.callID)
            events.push({
              _tag: "ToolStart",
              id: part.callID,
              name,
              target: toolTarget(part.tool, state.input as Record<string, unknown>),
              ...forAgent
            })
          }
          if (state.status === "running") {
            // Best-effort live output: stream a running command's partial stdout
            // as a ToolDelta when opencode exposes it (see `runningOutput`). Only
            // when it has actually grown, so an unchanged running update is silent.
            const partial = runningOutput(state.metadata)
            if (partial !== null && partial.length !== streamedLen.get(part.callID)) {
              streamedLen.set(part.callID, partial.length)
              events.push({ _tag: "ToolDelta", id: part.callID, output: capOutput(partial), ...forAgent })
            }
          }
          if (state.status === "completed") {
            events.push({
              _tag: "ToolEnd",
              id: part.callID,
              status: "success",
              meta: state.title.length > 0 ? state.title : null,
              diff: null,
              // opencode returns tool output as a plain string; the transcript
              // renders it as the collapsed preview.
              preview: state.output.length > 0 ? state.output : null,
              ...forAgent
            })
          }
          if (state.status === "error") {
            events.push({
              _tag: "ToolEnd",
              id: part.callID,
              status: "error",
              meta: state.error,
              diff: null,
              preview: null,
              ...forAgent
            })
          }
          return events
        }
        return []
      }

      case "step-finish": {
        // A live, growing count for the UI mid-turn; the FINAL total comes from
        // the prompt response, not from here. Only the RUN's own steps count —
        // the readout is the turn's, and a subagent's usage rolls up into the
        // parent's total anyway (Claude's adapter draws the same line).
        if (agentId !== undefined) return []
        tokens += totalTokens(part.tokens)
        return [{ _tag: "Usage", tokens }]
      }

      default:
        return []
    }
  }

  return {
    apply: (event: Event): ReadonlyArray<StreamEvent> => {
      switch (event.type) {
        case "message.updated": {
          const info = event.properties.info
          if (info.role === "user") userMessages.add(info.id)
          return []
        }

        /**
         * A `task` tool runs its subagent in a CHILD session. Opening a tab for
         * it here — rather than off the `task` tool call — is what lets its work
         * be attributed at all: the child's parts carry only its session id, and
         * this is the one event that ties that id to a parent, a name and a
         * description.
         *
         * `parentID` gives nesting for free: a subagent that spawns another
         * parents to it, exactly as Claude's tabs nest by `tool_use` id.
         */
        case "session.created": {
          const info = event.properties.info as {
            id?: string
            parentID?: string
            agent?: string
            title?: string
          }
          const run = opencodeSessionId()
          if (info.id === undefined || info.parentID === undefined) return []
          // Only sessions descended from THIS run — the server is private, but a
          // resumed run can have older children on it whose sessions it did not
          // just spawn.
          if (info.parentID !== run && !subagents.has(info.parentID)) return []
          subagents.set(info.id, info.parentID)
          return [
            {
              _tag: "SubagentStarted",
              id: info.id,
              name: info.agent ?? "agent",
              description: info.title ?? "",
              // Null when the RUN spawned it; otherwise the sub-agent that did.
              parentId: info.parentID === run ? null : info.parentID
            }
          ]
        }

        case "session.idle": {
          // The run's own idle is not a turn end (`session.prompt` resolving is
          // — see `driveOpencode`), but a CHILD's idle is that subagent finishing.
          const id = event.properties.sessionID
          return subagents.has(id) ? [{ _tag: "SubagentEnded", id, status: "done" }] : []
        }

        case "message.part.updated": {
          const part = event.properties.part
          if (userMessages.has(part.messageID)) return []
          // NOT filtered by session: a subagent's parts arrive under the CHILD's
          // id, and dropping them made its work invisible. `forPart` attributes
          // them instead. The server is private to this run, so everything on
          // this bus is ours to show.
          return forPart(part)
        }

        case "session.error": {
          const run = opencodeSessionId()
          const errored = event.properties.sessionID
          // A subagent's failure ends ITS tab; only the run's own error fails the
          // turn.
          if (errored !== undefined && subagents.has(errored)) {
            return [{ _tag: "SubagentEnded", id: errored, status: "error" }]
          }
          if (run !== null && errored !== undefined && errored !== run) return []
          const error = event.properties.error
          const message =
            error === undefined
              ? "opencode reported an unknown error"
              : // The error union's payloads all carry a `message`, but the shape
                // is provider-dependent — read defensively rather than switch on
                // every tag and go stale.
                ((error.data as { message?: string } | undefined)?.message ?? error.name)
          return [{ _tag: "Failed", message }]
        }

        default:
          return []
      }
    }
  }
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

/**
 * The line `opencode serve` prints once it's listening. We parse the URL from it
 * rather than pre-picking a port: `--port=0` lets the OS hand us a free one, so
 * concurrent sessions can't collide.
 */
const LISTENING = /opencode server listening on\s+(https?:\/\/\S+)/

export const parseServerUrl = (output: string): string | null => LISTENING.exec(output)?.[1] ?? null

// ── The live adapter ─────────────────────────────────────────────────────────

/**
 * Run one opencode turn in the session's worktree. Spawns a private server bound
 * to loopback, streams normalized events via `ctx.emit`, bridges opencode's
 * permission bus onto `ctx.canUseTool`, and stores the opencode session id in
 * `resume` for multi-turn continuation. Interrupting the Effect aborts the run
 * and tears the server down.
 */
export const runOpencode = (
  sessionId: string,
  spec: SessionSpec,
  ctx: AgentContext,
  resume: Map<string, string>
): Effect.Effect<void, CliExecError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runP = <A>(effect: Effect.Effect<A>): Promise<A> => Runtime.runPromise(runtime)(effect)
    const abort = new AbortController()

    yield* Effect.tryPromise({
      try: () => driveOpencode(sessionId, spec, ctx, resume, runP, abort.signal),
      catch: (cause) =>
        new CliExecError({
          kind: spec.cli,
          message: cause instanceof Error ? cause.message : String(cause)
        })
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => abort.abort())))
  })

const driveOpencode = async (
  sessionId: string,
  spec: SessionSpec,
  ctx: AgentContext,
  resume: Map<string, string>,
  runP: <A>(effect: Effect.Effect<A>) => Promise<A>,
  signal: AbortSignal
): Promise<void> => {
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const { spawn } = await import("node:child_process")

  if (spec.binPath === null) throw new Error("opencode binary not found")

  // `--port=0` → the OS picks a free port, so parallel sessions never collide.
  const proc = spawn(spec.binPath, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd: spec.cwd || undefined,
    env: {
      ...process.env,
      // Layers OVER the user's own opencode config rather than replacing it, so
      // their providers/keys/levers survive and we only pin what this run needs.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: mapOpencodePermission(spec.mode, spec.readOnly ?? false)
      })
    },
    stdio: ["ignore", "pipe", "pipe"]
  })

  const kill = (): void => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM")
  }
  signal.addEventListener("abort", kill, { once: true })

  try {
    const url = await waitForServer(proc, signal)
    const client = createOpencodeClient({ baseUrl: url })

    let opencodeSessionId: string | null = null
    const mapper = createOpencodeMapper(() => opencodeSessionId)

    // Subscribe BEFORE prompting: the permission bus is how the agent asks to
    // act, so missing early events would deadlock the very first tool call.
    // The signal matters — the SSE client reconnects on failure by default, so
    // without it a torn-down server would be retried every few seconds forever.
    const events = await client.event.subscribe({ signal })

    const bridge = new PermissionBridge(client, ctx, runP)
    const pump = (async () => {
      for await (const event of events.stream) {
        if (signal.aborted) return
        const asked = asPermissionAsked(event)
        if (asked !== null) {
          // EVERY permission this server raises gets answered — deliberately not
          // just the run's own session.
          //
          // The `task` tool runs its subagent in a CHILD session with its own id,
          // and the subagent's gated actions raise permissions under THAT id.
          // Matching on the run's session id therefore dropped them: nobody ever
          // replied, opencode waited forever, and `session.prompt` never resolved
          // — a silently hung turn the operator could only cancel. Verified live:
          // a `task` that writes a file deadlocks under the old filter.
          //
          // Answering everything is right rather than merely expedient: this
          // server is spawned by this run, on a random loopback port, for this
          // run alone. There is no other session on it whose permissions could
          // arrive here.
          //
          // Don't await: the operator may sit on this for minutes, and the pump
          // must keep draining or the events around it never arrive.
          void bridge.handle(asked)
          continue
        }
        for (const se of mapper.apply(event)) await runP(ctx.emit(se))
      }
      // Observed HERE, at declaration — not at the `await pump` below.
      //
      // Anything that throws between this line and the inner `try` (a failed
      // `session.create`, an id-less response, an emit that rejects) skips that
      // await entirely. The outer `finally` then kills the server, which rejects
      // this stream with nothing watching it — and an unhandled rejection takes
      // the whole Electron main process down on Node >=15. The turn's outcome is
      // driven by `session.prompt`, not by this loop, so swallowing here costs
      // only streamed events on a run that is already failing.
    })().catch(() => {})

    // Prefer the live in-memory id (this launch), else the one persisted on the
    // session (survives an app restart), so "continue" resumes the opencode
    // conversation instead of starting a fresh one. `fresh` opts out entirely.
    const prior = spec.fresh === true ? undefined : (resume.get(sessionId) ?? spec.resumeId ?? undefined)
    if (prior !== undefined) {
      opencodeSessionId = prior
    } else {
      const created = await client.session.create({ body: {} })
      const id = created.data?.id
      if (id === undefined) throw new Error("opencode did not return a session id")
      opencodeSessionId = id
    }

    if (spec.fresh !== true) resume.set(sessionId, opencodeSessionId)
    // Carry opencode's OWN session id so the runner persists it as the resume id.
    await runP(ctx.emit({ _tag: "Started", sessionId: opencodeSessionId }))

    try {
      const result = await client.session.prompt({
        path: { id: opencodeSessionId },
        body: {
          ...(spec.model === null ? {} : { model: splitModelId(spec.model) }),
          parts: [{ type: "text", text: spec.prompt }]
        }
      })

      // The SDK REPORTS failure rather than throwing it, so this has to be
      // checked: an unchecked `data?.info` turns a rejected prompt into a `Done`
      // with zero tokens — the run does nothing at all and reports success, and
      // the operator is left with no error to act on. Raise it instead; the
      // runner folds a failed run into a `Failed` the transcript shows.
      if (result.error !== undefined) throw new Error(promptError(result.error))

      // The turn is over the moment this resolves — `session.idle` lands AFTER
      // it, so waiting for the bus would mean never emitting `Done` at all. The
      // response's own message is the authoritative cost/token record.
      const info = result.data?.info
      if (!signal.aborted) {
        await runP(
          ctx.emit(
            info === undefined
              ? { _tag: "Done", costUsd: 0, tokens: 0 }
              : { _tag: "Done", costUsd: info.cost, tokens: totalTokens(info.tokens) }
          )
        )
      }
    } finally {
      // Whatever happened to the turn, the server is about to go: stop the pump
      // and silence any permission still parked behind the operator.
      bridge.close()
      await events.stream.return(undefined).catch(() => {})
      // `pump` can no longer reject — it's observed at declaration.
      await pump
    }

    if (signal.aborted) {
      await client.session.abort({ path: { id: opencodeSessionId } }).catch(() => {})
    }
  } finally {
    signal.removeEventListener("abort", kill)
    kill()
  }
}

/**
 * Resolve once the server announces its URL, or reject if it dies first. Without
 * the exit/error races a failed spawn would hang until the caller gave up, with
 * the server's own stderr — the thing that says why — thrown away.
 */
const waitForServer = (
  proc: import("node:child_process").ChildProcess,
  signal: AbortSignal
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let output = ""
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const url = parseServerUrl(output)
      if (url !== null) done(() => resolve(url))
    })
    // opencode logs to stderr; keep it for the error message.
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.on("error", (error) => done(() => reject(error)))
    proc.on("exit", (code) =>
      done(() =>
        reject(new Error(`opencode serve exited with code ${code}${output.trim() ? `\n${output}` : ""}`))
      )
    )
    signal.addEventListener("abort", () => done(() => reject(new Error("aborted"))), { once: true })
  })

/**
 * Bridges opencode's ASYNCHRONOUS permission bus onto Starbase's synchronous
 * `canUseTool` gate.
 *
 * opencode raises `permission.updated` and then waits for a reply on a separate
 * endpoint; `ctx.canUseTool` is a promise-shaped ask that parks until the
 * operator answers. So each permission runs as its own detached task: ask, then
 * reply. Two races have to be survived:
 *
 *  - The same permission being answered twice (`replied`) — opencode treats a
 *    duplicate reply as an error.
 *  - The operator answering AFTER the turn ended (`closed`). The detached task
 *    is still parked on `canUseTool` when the server goes away, so a late answer
 *    must become a no-op rather than a POST to a dead port. This is why `close`
 *    latches instead of clearing: the run is over, and nothing more should be
 *    said to a server that isn't there.
 */
class PermissionBridge {
  private readonly replied = new Set<string>()
  private closed = false

  constructor(
    private readonly client: import("@opencode-ai/sdk").OpencodeClient,
    private readonly ctx: AgentContext,
    private readonly runP: <A>(effect: Effect.Effect<A>) => Promise<A>
  ) {}

  async handle(asked: PermissionAsked): Promise<void> {
    try {
      const decision = await this.runP(this.ctx.canUseTool(permissionToRequest(asked)))
      // `once` rather than `always`: Starbase's own allowlist decides what is
      // remembered, so letting opencode cache an approval would silently widen
      // a grant the operator scoped to a single action.
      await this.reply(asked, decision === "allow" ? "once" : "reject")
    } catch {
      // A bridge failure must not leave the agent waiting forever.
      await this.reply(asked, "reject")
    }
  }

  private async reply(asked: PermissionAsked, response: "once" | "always" | "reject"): Promise<void> {
    if (this.closed || this.replied.has(asked.id)) return
    this.replied.add(asked.id)
    await this.client
      .postSessionIdPermissionsPermissionId({
        path: { id: asked.sessionID, permissionID: asked.id },
        body: { response }
      })
      .catch(() => {})
  }

  /** The turn is over — silence any reply still in flight behind the operator. */
  close(): void {
    this.closed = true
  }
}
