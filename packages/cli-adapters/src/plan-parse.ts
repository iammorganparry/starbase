import type {
  CliKind,
  DiffStat,
  Plan,
  PlanEdge,
  PlanFileChange,
  PlanGraph,
  PlanGuard,
  PlanNode,
  PlanNodeKind,
  PlanStep,
  PlanStepAssignee,
  PlanStepCode,
  RouteEffort,
  RouteRisk,
  TaskKind
} from "@starbase/core"
import { CLI_KINDS, TASK_KINDS } from "@starbase/core"

/**
 * Turn the plan text Claude produces via `ExitPlanMode` into a structured `Plan`.
 *
 * We can't rely on the model to emit JSON, so we ask it (via
 * `planModeInstructions`) to include a small, line-oriented ` ```plan ` block and
 * parse that here. Everything is best-effort and forgiving: a missing/garbled
 * block falls back to a single step that carries the raw markdown, so the plan is
 * always renderable and never lost. Pure and deterministic given `(raw, id)` —
 * the primary unit-test seam for plan mode.
 */

// ── The output protocol injected into the plan-mode system prompt ─────────────

/**
 * How the agent hands its finished plan back. Claude has a real `ExitPlanMode`
 * tool the adapter intercepts; every other harness has nothing to call, so it
 * ends its reply with the block and stops, and the adapter reads it out of the
 * message text.
 *
 * Parameterised rather than duplicated because the GRAMMAR is the contract with
 * `parsePlan` and must not drift between harnesses — only the two sentences
 * about how to submit it legitimately differ.
 */
export type PlanChannel = "tool" | "reply"

const OPENING: Readonly<Record<PlanChannel, string>> = {
  tool: "When you present your plan with ExitPlanMode, put a fenced ```plan block at the top of the plan text, then your normal human-readable markdown below it.",
  reply:
    "When your plan is ready, put a fenced ```plan block at the top of your reply, then your normal human-readable markdown below it — and STOP there, without editing anything."
}

const SUBMIT_RULE: Readonly<Record<PlanChannel, string>> = {
  tool: "Only ExitPlanMode; do not edit files or run commands in plan mode.",
  reply:
    "Emit the block and stop — do not edit files or run commands in plan mode. The block is parsed into an interactive plan the operator approves, comments on, or sends back for revision; if they approve it you will be prompted again, with write access, to carry it out."
}

/**
 * The plan output protocol injected for a plan-mode turn. Documents the
 * ` ```plan ` block so what the agent submits parses into structured steps. Kept
 * declarative: one block, documented field names, no per-call string assembly
 * elsewhere.
 */
export const planInstructions = (channel: PlanChannel): string =>
  `${OPENING[channel]} Starbase renders the block as an interactive, reviewable plan.

Format of the \`\`\`plan block (one step per header line; two-space-indented fields):

  summary: <one short line naming the whole change>
  01 <step title>
    intent: <one sentence — why this step exists>
    approach: <how, step one; how, step two>          (semicolon-separated)
    files: M path/to/file.ts +12 -3; A path/to/new.ts +40   (A add / M modify / D delete, then +added -removed)
    guards: <acceptance criterion>; <another> (warn)   (append (warn)/(open)/(review) to flag one)
    depends: 01; blocks: 03
  02 <next step title>
    ...
  04 <a branching step>
    branch: <the yes/no condition, e.g. "token expired?">
    4a <arm taken when yes>
      intent: ...
    4b <arm taken when no>
      intent: ...
  05 <step>
  06 <step>

Rules: number steps 01, 02, … in order; a branch's arms are numbered 4a, 4b under it (two extra spaces). Keep each step's title under ~6 words and its intent to one sentence. ${SUBMIT_RULE[channel]}

ALSO, for each step whose logic actually branches or moves through states, include a fenced \`\`\`flow step <NN> block that maps THAT STEP's own control flow — a state machine, a user flow, or the decision tree grounded in the step's code. One flow PER STEP, scoped to what that step does. Skip the block entirely for steps that are a straight-line edit with no meaningful decisions (most simple steps need none). This is the most important visual: focus on the branch points, not a linear list of actions. One node or edge per line:

  \`\`\`flow step 04
  start   n0  "HTTP request"
  action  n1  "authMiddleware" file src/auth/session.ts
  decision n2 "token expired?"
  action  n3  "refresh() + retry once"
  action  n4  "proceed"
  terminal n5 "response"
  n0 -> n1
  n1 -> n2
  n2 -> n3 : yes
  n2 -> n4 : no
  n3 -> n5
  n4 -> n5
  \`\`\`

The block's info string MUST name the step (\`flow step <NN>\`, matching a plan step's number). Node syntax: \`<kind> <id> "<label>"\` where kind is start|decision|action|io|terminal|note; optionally add \`file <path>\` (a detail line). Edge syntax: \`<from> -> <to>\` with an optional \`: <condition>\` label (put the yes/no or condition on the edges LEAVING a decision node).

FINALLY, for the steps where it aids review — new service methods, key types, and the tests that cover them — include a short illustrative code sample so the operator can scrutinise the SHAPE of the change (signatures, error handling, test cases) before approving. Emit it as a normal fenced code block whose info string names the step: put \`step <NN>\` after the language. One block per step; keep it to the essential lines (a method signature + body sketch, or a test's arrange/act/assert), not the whole file:

  \`\`\`ts step 02
  export class TokenStore extends Effect.Service<TokenStore>()("TokenStore", {
    effect: Effect.gen(function* () {
      return {
        get: (id: string) => Effect.succeed(/* … */),
        refresh: (session: Session) => Effect.gen(function* () { /* … */ })
      }
    })
  }) {}
  \`\`\`

The language is the highlight hint (ts, tsx, py, go, …); \`step <NN>\` (or \`step=<NN>\`) links the sample to that plan step.`

/** The Claude variant, passed to the SDK as `planModeInstructions`. */
export const planModeInstructions = planInstructions("tool")

// ── Parsing ───────────────────────────────────────────────────────────────────

const GUARD_STATUS: Record<string, PlanGuard["status"]> = {
  warn: "warn",
  open: "open",
  ok: "ok",
  review: "under-review"
}

/**
 * Extract the first fenced block whose info string is EXACTLY `lang`, or null.
 *
 * The info string must be the language alone (trailing spaces are fine) — a
 * prefix match would let a ` ```planning ` block masquerade as the plan spec:
 * the reformat bounce would be skipped and its contents parsed as steps.
 */
const fenced = (raw: string, lang: string): string | null => {
  const re = new RegExp("```" + lang + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "i")
  const m = re.exec(raw)
  return m ? m[1]!.replace(/\s+$/, "") : null
}

/**
 * Whether the agent actually emitted the ` ```plan ` fence we asked for.
 *
 * `planModeInstructions` documents the format, but prompt compliance is never
 * guaranteed — the adapter uses this to bounce a fence-less plan back for one
 * reformat rather than degrading straight to the raw fallback.
 */
export const hasPlanBlock = (raw: string): boolean => fenced(raw, "plan") !== null

/** Numeric-only ordinals pad to two digits ("4" → "04"); arms ("4a") stay as-is. */
const normNum = (n: string): string => (/^\d+$/.test(n) ? n.padStart(2, "0") : n)

const stepId = (n: string): string => `s_${normNum(n)}`

/** The branch step id an arm hangs off — "4a" → the parent's id "s_04". */
const parentIdOf = (armNumber: string): string | null => {
  const m = /^(\d+)[a-z]$/.exec(armNumber)
  return m ? `s_${m[1]!.padStart(2, "0")}` : null
}

const clean = (parts: ReadonlyArray<string>): ReadonlyArray<string> =>
  parts.map((s) => s.trim()).filter((s) => s.length > 0)

/**
 * Split a prose/code field — `approach`, `guards`, `files`.
 *
 * Semicolons ONLY. The format documents these as semicolon-separated precisely
 * because their values are prose and code, which are full of commas: splitting
 * on commas too tears `meetsMinVersion(raw, min)` into "…meetsMinVersion(raw"
 * and "min)", and turns the guard "fires once, even on repeated 401s" into two
 * fragments that each say nothing.
 */
const splitProse = (v: string): ReadonlyArray<string> => clean(v.split(";"))

/**
 * Split a list of step ordinals — `depends`, `blocks`.
 *
 * Commas are fine here, unlike the prose fields: an ordinal ("01", "4a") can't
 * contain one, so "01, 02" and "01; 02" can safely mean the same two steps.
 */
const splitRefs = (v: string): ReadonlyArray<string> => clean(v.split(/[;,]/))

/** The relation fields — the only ones the format puts two-to-a-line. */
const RELATION = /^\s*(depends|blocks)\s*:\s*(.*)$/i

/**
 * Parse an `agent:` field — `<cli> <model> — <why>`.
 *
 * The harness and model are separate tokens rather than a single `cli/model`
 * pair on purpose: opencode's own ids are provider-qualified and routinely
 * contain slashes (`openrouter/anthropic/claude-opus-4.5`), so splitting on "/"
 * would tear a model id in half and name a harness that doesn't exist.
 *
 * An unknown harness yields null rather than a guess — an assignee naming a CLI
 * we can't run produces a broken session, which is worse than no assignee.
 */
const parseAssignee = (value: string): PlanStepAssignee | null => {
  const m = /^\s*(\S+)\s+(\S+)\s*(?:[—–-]\s*(.*))?$/.exec(value)
  if (!m) return null
  const cli = m[1]!.toLowerCase()
  if (!(CLI_KINDS as ReadonlyArray<string>).includes(cli)) return null
  // A step assigned back to the orchestrator would re-enter planning to execute
  // one step of the plan it just made. Steps run on real harnesses only.
  if (cli === "starbase") return null
  return { cli: cli as CliKind, model: m[2]!, reason: (m[3] ?? "").trim() }
}

/**
 * Peel a trailing relation field out of a value.
 *
 * The format writes both relations on ONE line — `depends: 01; blocks: 03` — so
 * reading that line as a single field swallows the second: `blocks` goes unset
 * while `dependsOn` gains a junk "blocks: 03" entry. Applied only to relation
 * fields, so prose that happens to contain "…; blocks: …" is left alone.
 */
const splitRelations = (key: string, value: string): ReadonlyArray<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = []
  let k = key
  let buf: Array<string> = []
  for (const token of value.split(";")) {
    const m = RELATION.exec(token)
    if (m) {
      out.push([k, buf.join(";")] as const)
      k = m[1]!.toLowerCase()
      buf = [m[2]!]
    } else buf.push(token)
  }
  out.push([k, buf.join(";")] as const)
  return out
}

const parseFile = (token: string): PlanFileChange | null => {
  const m = /^([AMD])\s+(\S+)(?:\s+\+(\d+))?(?:\s+-(\d+))?/.exec(token.trim())
  if (!m) return null
  return { path: m[2]!, change: m[1] as PlanFileChange["change"], added: Number(m[3] ?? 0), removed: Number(m[4] ?? 0) }
}

const parseGuard = (token: string): PlanGuard => {
  const m = /^(.*?)\s*(?:\((warn|open|ok|review)\))?\s*$/i.exec(token.trim())
  const text = (m?.[1] ?? token).trim()
  const status = m?.[2] ? GUARD_STATUS[m[2].toLowerCase()]! : "ok"
  return { text, status }
}

const sumDiff = (files: ReadonlyArray<PlanFileChange>): DiffStat | null => {
  if (files.length === 0) return null
  return files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), {
    added: 0,
    removed: 0
  })
}

/** A mutable working copy of a step, assembled field-by-field then frozen as `PlanStep`. */
type MutableStep = { -readonly [K in keyof PlanStep]: PlanStep[K] }

/** A blank, well-formed step keyed by its ordinal. */
const emptyStep = (number: string, title: string): MutableStep => {
  const arm = /^\d+[a-z]$/.test(number)
  return {
    id: stepId(number),
    number: normNum(number),
    title,
    intent: "",
    approach: [],
    kind: arm ? "branch-arm" : "step",
    condition: null,
    parentId: arm ? parentIdOf(number) : null,
    dependsOn: [],
    blocks: [],
    files: [],
    guards: [],
    code: null,
    diff: null,
    status: "proposed",
    flagged: false
  }
}

const STEP_HEADER = /^\s*(\d+[a-z]?)\s+(.+?)\s*$/
const FIELD = /^\s+([a-z]+)\s*:\s*(.+?)\s*$/i

/** Parse the lines inside a `plan` block into steps + a summary. */
const parseBlock = (block: string): { summary: string; steps: PlanStep[] } => {
  const steps: MutableStep[] = []
  let summary = ""
  let current: MutableStep | null = null
  const setDiff = (s: MutableStep): MutableStep => ({ ...s, diff: sumDiff(s.files) })

  const flush = () => {
    if (current) steps.push(setDiff(current))
    current = null
  }

  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue
    const summaryMatch = /^\s*summary\s*:\s*(.+?)\s*$/i.exec(line)
    if (summaryMatch && current === null) {
      summary = summaryMatch[1]!
      continue
    }
    const field = current ? FIELD.exec(line) : null
    const header = STEP_HEADER.exec(line)
    // A field only counts when it's more-indented than a step header would be
    // and matches a known key — otherwise a header wins (e.g. "04 Handle…").
    if (field && (!header || line.startsWith("  "))) {
      const key = field[1]!.toLowerCase()
      const value = field[2]!
      const s = current!
      // One line can carry both relations (`depends: 01; blocks: 03`), so a
      // relation field may yield two; everything else is a single field whose
      // value is taken whole.
      const fields =
        key === "depends" || key === "blocks"
          ? splitRelations(key, value)
          : [[key, value] as const]
      for (const [k, v] of fields) {
        switch (k) {
          case "intent":
            s.intent = v
            break
          case "approach":
            s.approach = splitProse(v)
            break
          case "files":
            s.files = splitProse(v).map(parseFile).filter((f): f is PlanFileChange => f !== null)
            break
          case "guards":
            s.guards = splitProse(v).map(parseGuard)
            break
          case "depends":
            s.dependsOn = splitRefs(v).map(normNum)
            break
          case "blocks":
            s.blocks = splitRefs(v).map(normNum)
            break
          case "branch":
            s.kind = "branch"
            s.condition = v
            break
          case "task": {
            // Only used by adversarial planning; plain plan mode never emits it.
            // Silently ignored when the model invents a kind outside the closed
            // vocabulary, because a bogus value would key learnings to a cell
            // nothing else can ever read.
            const kind = v.trim().toLowerCase()
            if ((TASK_KINDS as ReadonlyArray<string>).includes(kind)) {
              s.taskKind = kind as TaskKind
            }
            break
          }
          case "effort": {
            const effort = v.trim().toLowerCase()
            if (effort === "quick" || effort === "standard" || effort === "deep") {
              s.effort = effort satisfies RouteEffort
            }
            break
          }
          case "risk": {
            const risk = v.trim().toLowerCase()
            if (risk === "low" || risk === "medium" || risk === "high") {
              s.risk = risk satisfies RouteRisk
            }
            break
          }
          case "agent": {
            const assignee = parseAssignee(v)
            if (assignee !== null) s.assignee = assignee
            break
          }
        }
      }
      continue
    }
    if (header) {
      flush()
      current = emptyStep(header[1]!, header[2]!)
    }
  }
  flush()

  // Any step that an arm hangs off is a branch, even without an explicit field.
  const parents = new Set(steps.filter((s) => s.kind === "branch-arm").map((s) => s.parentId))
  for (const s of steps) {
    if (parents.has(s.id) && s.kind !== "branch") s.kind = "branch"
  }
  return { summary, steps }
}

const NODE_KINDS = new Set<PlanNodeKind>(["start", "decision", "action", "io", "terminal", "note"])
const NODE_LINE = /^(start|decision|action|io|terminal|note)\s+(\S+)\s+"([^"]*)"(.*)$/
const EDGE_LINE = /^(\S+)\s*->\s*(\S+)(?:\s*:\s*(.+?))?\s*$/

const parseNode = (m: RegExpExecArray): PlanNode => {
  const rest = m[4] ?? ""
  const step = /\bstep\s+(\S+)/.exec(rest)
  const file = /\bfile\s+(\S+)/.exec(rest)
  const detailQuoted = /"([^"]*)"/.exec(rest)
  return {
    id: m[2]!,
    label: m[3]!,
    kind: m[1] as PlanNodeKind,
    detail: file?.[1] ?? detailQuoted?.[1] ?? null,
    stepId: step ? stepId(step[1]!) : null
  }
}

/**
 * Parse the body of a flow block into a decision graph (nodes + edges). Node
 * lines start with a kind keyword; every other `a -> b` line is an edge whose
 * optional `: label` carries the condition. Returns null when there's nothing
 * renderable, so the Flow view falls back to its empty state.
 */
const graphFromBlock = (block: string): PlanGraph | null => {
  const nodes: Array<PlanNode> = []
  const edges: Array<PlanEdge> = []
  for (const line of block.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const nodeMatch = NODE_LINE.exec(trimmed)
    if (nodeMatch && NODE_KINDS.has(nodeMatch[1] as PlanNodeKind)) {
      nodes.push(parseNode(nodeMatch))
      continue
    }
    const edgeMatch = EDGE_LINE.exec(trimmed)
    if (edgeMatch) {
      edges.push({
        id: `e_${edges.length}`,
        from: edgeMatch[1]!,
        to: edgeMatch[2]!,
        label: edgeMatch[3]?.trim() || null
      })
    }
  }
  // Drop edges that dangle (reference a node we never declared) — keeps the layout sane.
  const known = new Set(nodes.map((n) => n.id))
  const kept = edges.filter((e) => known.has(e.from) && known.has(e.to))
  return nodes.length > 0 ? { nodes, edges: kept } : null
}

/** Matches every fenced ` ```flow … ` block, capturing its info string + body. */
const FLOW_BLOCK = /```flow[ \t]*([^\n]*)\n([\s\S]*?)```/gi

/**
 * Legacy: parse a single UNtagged ` ```flow ` block (per-step flows use
 * ` ```flow step NN `). Returns null when there's no untagged block, so old
 * single-flow plans keep rendering while new plans carry flows per step.
 */
export const parseFlow = (raw: string): PlanGraph | null => {
  FLOW_BLOCK.lastIndex = 0
  // `for (;;)` with an explicit break, not an assignment in the loop condition:
  // the latter reads as a comparison at a glance, and the re-scan can't move to
  // the end of the body because the body `continue`s past it.
  for (;;) {
    const m = FLOW_BLOCK.exec(raw)
    if (m === null) break
    if (/\bstep\b/i.test(m[1] ?? "")) continue
    return graphFromBlock(m[2] ?? "")
  }
  return null
}

/**
 * Parse every ` ```flow step NN ` block into a map of normalized step number →
 * that step's own decision/logic flow. A step without a flow block simply isn't
 * in the map (its `graph` stays null). First block per step wins.
 */
export const parseStepFlows = (raw: string): Map<string, PlanGraph> => {
  const out = new Map<string, PlanGraph>()
  FLOW_BLOCK.lastIndex = 0
  for (;;) {
    const m = FLOW_BLOCK.exec(raw)
    if (m === null) break
    const step = /\bstep\s*=?\s*(\d+[a-z]?)\b/i.exec(m[1] ?? "")
    if (!step) continue
    const num = normNum(step[1]!)
    if (out.has(num)) continue
    const graph = graphFromBlock(m[2] ?? "")
    if (graph) out.set(num, graph)
  }
  return out
}

/**
 * Scan every fenced code block whose info string links it to a step (e.g.
 * ` ```ts step 02 `) into a map of normalized step number → `PlanStepCode`. The
 * ` ```plan ` block carries no `step`, and ` ```flow step NN ` blocks are
 * explicitly excluded (they're parsed as per-step flows, not code samples).
 */
export const parseStepCode = (raw: string): Map<string, PlanStepCode> => {
  const out = new Map<string, PlanStepCode>()
  const re = /```([^\n]*)\n([\s\S]*?)```/g
  for (;;) {
    const m = re.exec(raw)
    if (m === null) break
    const info = (m[1] ?? "").trim()
    // Per-step flow blocks (` ```flow step NN `) also carry a step tag — they're
    // graphs, not code, so never treat them as a code sample.
    if (/^flow\b/i.test(info)) continue
    const stepMatch = /\bstep\s*=?\s*(\d+[a-z]?)\b/i.exec(info)
    if (!stepMatch) continue
    const num = normNum(stepMatch[1]!)
    if (out.has(num)) continue // first sample per step wins
    const first = info.split(/\s+/)[0] ?? ""
    const lang = first.length > 0 && first.toLowerCase() !== "step" && !/^step=/i.test(first) ? first : null
    const body = (m[2] ?? "").replace(/\s+$/, "")
    if (body.length > 0) out.set(num, { lang, body })
  }
  return out
}

/**
 * Parse a raw `ExitPlanMode` plan into a structured `Plan`. Falls back to a
 * single step wrapping the markdown when there's no parseable ` ```plan ` block.
 */
export const parsePlan = (raw: string, id: string): Plan => {
  const block = fenced(raw, "plan")
  const graph = parseFlow(raw)
  const code = parseStepCode(raw)
  const flows = parseStepFlows(raw)
  const parsed = block ? parseBlock(block) : { summary: "", steps: [] as PlanStep[] }

  if (parsed.steps.length === 0) {
    // Fallback: no structured block — surface the first heading as the summary and
    // keep one step so the tab/badge still work. `structured: false` is what tells
    // the UI to render `raw`; without it the plan's actual content is invisible.
    const firstLine = raw.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0)
    const summary = parsed.summary || firstLine || "Proposed plan"
    return {
      id,
      summary,
      structured: false,
      graph,
      steps: [
        {
          id: "s_01",
          number: "01",
          title: summary,
          intent: "The agent didn't use the structured plan format — its full plan is below.",
          approach: [],
          kind: "step",
          condition: null,
          parentId: null,
          dependsOn: [],
          blocks: [],
          files: [],
          guards: [],
          code: null,
          // No structured steps — hang any single legacy flow on the one step so
          // it still renders per-step.
          graph,
          diff: null,
          status: "proposed",
          flagged: false
        }
      ],
      comments: [],
      status: "proposed",
      raw
    }
  }

  return {
    id,
    summary: parsed.summary || parsed.steps[0]!.title,
    structured: true,
    graph,
    // Attach any per-step code sample + per-step flow, keyed by the step's
    // normalized number.
    steps: parsed.steps.map((s) => ({
      ...s,
      ...(code.has(s.number) && { code: code.get(s.number)! }),
      ...(flows.has(s.number) && { graph: flows.get(s.number)! })
    })),
    comments: [],
    status: "proposed",
    raw
  }
}
