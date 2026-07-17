import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W2 — a PR's checks: what's green, what's still going, what broke. */

const RUN_SUBS = new Set(["watch", "list", "view"])

export type CheckState = "pass" | "fail" | "running" | "queued" | "skipped" | "cancelled"

export interface PrCheck {
  name: string
  state: CheckState
  /** What the check reported about itself; null while it's queued. */
  duration: string | null
}

export interface CiChecksProps {
  command: string
  status: ToolCallStatus
  /** From the command's args. Null when `gh` defaulted to the current branch. */
  pr: string | null
  branch: string | null
  checks: ReadonlyArray<PrCheck>
}

/**
 * gh's state words, as seen in the wild.
 *
 * `cancelled` gets its own state rather than folding into `skipped`: a check
 * someone stopped and a check that chose not to run are different facts, and the
 * row has room to say which.
 */
const STATES: Record<string, CheckState> = {
  pass: "pass",
  passed: "pass",
  success: "pass",
  successful: "pass",
  fail: "fail",
  failed: "fail",
  failure: "fail",
  pending: "running",
  in_progress: "running",
  queued: "queued",
  waiting: "queued",
  skipping: "skipped",
  skipped: "skipped",
  cancelled: "cancelled",
  canceled: "cancelled"
}

/** The human format's glyph column, when gh decided we were a person. */
const GLYPHS: Record<string, CheckState> = {
  "✓": "pass",
  "✔": "pass",
  "✗": "fail",
  "×": "fail",
  "✘": "fail",
  X: "fail",
  "*": "running",
  "-": "skipped",
  "○": "queued"
}

const DURATION = /^\d[\dhms.]*$/

/**
 * `build\tpass\t1m4s\thttps://…` — what `gh pr checks` prints without a tty.
 *
 * Columns are positional, so the tab split is the parse. Rows whose state word we
 * don't know are dropped rather than guessed at: an unknown state rendered as a
 * grey ring would be the widget inventing a fact.
 */
const tsvChecks = (out: string): PrCheck[] => {
  const checks: PrCheck[] = []
  for (const line of out.split("\n")) {
    if (!line.includes("\t")) continue
    const cols = line.split("\t")
    const name = cols[0]?.trim()
    const state = STATES[(cols[1] ?? "").trim().toLowerCase()]
    if (!name || !state) continue
    const duration = cols[2]?.trim()
    checks.push({ name, state, duration: duration ? duration : null })
  }
  return checks
}

/**
 * `✓  build         1m4s  https://…` — the same data, laid out for eyes.
 *
 * `[^\S\n]` rather than `\s` throughout: `\s` eats newlines, so the trailing
 * column group would run on and swallow every row after the first into one match.
 */
const HUMAN_LINE = /^[^\S\n]*([✓✔✗×✘X*\-○])[^\S\n]+(\S+)((?:[^\S\n]+\S+)*)[^\S\n]*$/gm

const humanChecks = (out: string): PrCheck[] => {
  const checks: PrCheck[] = []
  for (const m of out.matchAll(HUMAN_LINE)) {
    const state = GLYPHS[m[1]!]
    if (!state) continue
    const rest = (m[3] ?? "").trim().split(/\s+/).filter(Boolean)
    checks.push({
      name: m[2]!,
      state,
      duration: rest.find((t) => DURATION.test(t)) ?? null
    })
  }
  return checks
}

export const parseCiChecks = (ctx: ParseContext): CiChecksProps | null => {
  const out = ctx.output
  // `--watch` prints nothing until it settles. No rows, no scoreboard — decline.
  if (!out) return null

  const checks = tsvChecks(out)
  const parsed = checks.length > 0 ? checks : humanChecks(out)
  if (parsed.length === 0) return null

  return {
    command: ctx.command.primary,
    status: ctx.status,
    // `gh pr checks 482`; absent when gh resolves the PR from the branch instead.
    pr: ctx.command.args.find((a) => /^\d+$/.test(a)) ?? null,
    /*
     * `gh pr checks` never prints the branch, and the command rarely names it. We
     * could ask git — the widget can't. Null, and the header simply omits it;
     * "feat/oauth" under a card that never saw the words would be decoration.
     */
    branch: null,
    checks: parsed
  }
}

const stateLabel: Record<CheckState, string> = {
  pass: "passed",
  fail: "failed",
  running: "running",
  queued: "queued",
  skipped: "skipped",
  cancelled: "cancelled"
}

const stateClass: Record<CheckState, string> = {
  pass: "text-green",
  fail: "text-red",
  running: "text-yellow",
  queued: "text-dim",
  skipped: "text-dim",
  cancelled: "text-dim"
}

const nameClass: Record<CheckState, string> = {
  pass: "text-text",
  fail: "text-text-bright",
  running: "text-text-bright",
  queued: "text-muted-foreground",
  skipped: "text-muted-foreground",
  cancelled: "text-muted-foreground"
}

const glyphFor = (state: CheckState) => {
  if (state === "running") return <Spinner size={12} tone="working" />
  if (state === "pass") return <span className="text-green">✓</span>
  if (state === "fail") return <span className="text-red">✗</span>
  // An empty ring: nothing has happened to this check yet.
  return <span className="size-2 rounded-full border-[1.5px] border-dim" />
}

function Tally({ tone, count, label }: { tone: string; count: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <StatusDot tone={tone} size={6} pulse={false} />
      {count} {label}
    </span>
  )
}

export function CiChecksWidget(p: CiChecksProps) {
  const tally = (...states: CheckState[]) => p.checks.filter((c) => states.includes(c.state)).length
  const passed = tally("pass")
  const failed = tally("fail")
  const running = tally("running")
  /*
   * Each state tallies under its own name.
   *
   * These were grouped as "waiting", which is false for two of the three — a
   * skipped check isn't waiting, a cancelled one certainly isn't — and it also
   * contradicted the row beside it, which says "queued". A footer that
   * disagrees with the list it's summarising is worse than a longer footer.
   */
  const queued = tally("queued")
  const skipped = tally("skipped")
  const cancelled = tally("cancelled")
  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      icon={p.status === "running" ? <StatusDot tone="bg-yellow" size={9} pulse /> : undefined}
      headerMeta={p.pr ? <span className="font-mono text-blue">#{p.pr}</span> : undefined}
      footer={
        <span className="flex items-center gap-3.5">
          {passed > 0 && <Tally tone="bg-green" count={passed} label="passed" />}
          {failed > 0 && <Tally tone="bg-red" count={failed} label="failed" />}
          {running > 0 && <Tally tone="bg-yellow" count={running} label="running" />}
          {queued > 0 && <Tally tone="bg-line-strong" count={queued} label="queued" />}
          {skipped > 0 && <Tally tone="bg-line" count={skipped} label="skipped" />}
          {cancelled > 0 && <Tally tone="bg-line" count={cancelled} label="cancelled" />}
        </span>
      }
      /*
       * The design's "auto-merge on green" is omitted: whether auto-merge is armed
       * is a fact about the PR that `gh pr checks` never tells us. Promising a merge
       * that may never come is worse than saying nothing.
       */
      footerMeta={exitLabel(p.status) ?? undefined}
    >
      <WidgetBody className="gap-px px-2.5 py-2">
        {p.checks.map((c) => (
          <div
            key={c.name}
            className={cn(
              "flex items-center gap-[11px] rounded px-1.5 py-2 font-mono text-[12px]",
              c.state === "running" && "bg-blue/[0.05]"
            )}
          >
            <span className="flex w-3.5 flex-none items-center justify-center">{glyphFor(c.state)}</span>
            <span className={cn("min-w-0 flex-1 truncate", nameClass[c.state])}>{c.name}</span>
            <span className="flex-none text-dim">{c.duration ?? "—"}</span>
            <span className={cn("w-13 flex-none text-right text-[10px]", stateClass[c.state])}>
              {stateLabel[c.state]}
            </span>
          </div>
        ))}
      </WidgetBody>
    </CommandWidget>
  )
}

export const ciChecksWidget = defineWidget<CiChecksProps>({
  id: "ci-checks",
  match: (c) =>
    c.program === "gh" &&
    ((c.sub === "pr" && c.args.includes("checks")) ||
      (c.sub === "run" && c.args[1] !== undefined && RUN_SUBS.has(c.args[1]))),
  parse: parseCiChecks,
  render: (p) => <CiChecksWidget {...p} />
})
