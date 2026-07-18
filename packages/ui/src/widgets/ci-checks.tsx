import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W2 — a PR's checks: what's green, what's still going, what broke. */

/*
 * Only `gh pr checks` — NOT `gh run list/watch/view`.
 *
 * The parser reads the columns of `gh pr checks` TSV (name, state, duration).
 * `gh run list` prints a DIFFERENT layout — status, conclusion, title, workflow
 * — so its conclusion column ("success") lands in our state slot and every run
 * parses as a check literally named "completed" with the commit title where a
 * duration should be: a plausible board of pure garbage rather than a decline.
 * Until those formats are actually parsed, they belong on the generic card.
 */

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
  /** The adapter-reported exit meta (codex\'s real code), or null. */
  exit: string | null
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
 * `gh pr checks` flags that take a SEPARATE value token.
 *
 * Only these consume the next token — every other flag (`--watch`, `--required`,
 * `--fail-fast`, `--web`) is boolean. Assuming ANY bare flag takes a value was
 * the bug: `gh pr checks --watch 482` then read `482` as `--watch`'s value and
 * dropped the `#482` badge. `--flag=value` needs no entry (the `=` attaches it).
 */
const GH_VALUE_FLAGS = new Set(["-i", "--interval", "--json", "-q", "--jq", "-t", "--template", "-b", "--branch", "-R", "--repo"])

/**
 * The PR number in `gh pr checks 482 --interval 30` (or `--watch 482`).
 *
 * The PR selector is a positional numeric token; the trick is not mistaking a
 * value-flag's argument (`--interval 30`) for it. Skip only the flags that
 * genuinely take a value; treat the rest as boolean.
 */
const prNumber = (args: ReadonlyArray<string>): string | null => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith("-")) {
      if (!a.includes("=") && GH_VALUE_FLAGS.has(a)) i++ // this flag eats the next token
      continue
    }
    if (/^\d+$/.test(a)) return a
  }
  return null
}

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

/**
 * Keep the LAST row per check name.
 *
 * `gh pr checks --watch` — the widget's headline case — reprints the whole table
 * each time a check settles when its output is captured non-interactively. Every
 * reprint is collected, so a check appears many times: the footer tallies
 * multiply and `key={name}` collides in React. The last occurrence is the
 * freshest state, so dedupe forward.
 */
const dedupeByName = (checks: PrCheck[]): PrCheck[] => {
  const last = new Map<string, PrCheck>()
  for (const c of checks) last.set(c.name, c)
  return [...last.values()]
}

export const parseCiChecks = (ctx: ParseContext): CiChecksProps | null => {
  const out = ctx.output
  // `--watch` prints nothing until it settles. No rows, no scoreboard — decline.
  if (!out) return null

  const checks = tsvChecks(out)
  const parsed = dedupeByName(checks.length > 0 ? checks : humanChecks(out))
  if (parsed.length === 0) return null

  return {
    command: ctx.command.primary,
    status: ctx.status,
    exit: ctx.meta,
    // `gh pr checks 482`; absent when gh resolves the PR from the branch instead.
    // The number must not be a flag's value — `--interval 30` would read as PR
    // #30. Only a bare number that doesn't follow an option.
    pr: prNumber(ctx.command.args),
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
      /*
       * The board's whole point is the tally, and it lives in the footer — so the
       * collapsed row says that rather than the default exit code, which for a
       * `--watch` run still in flight isn't even settled yet.
       */
      summary={
        <span className="flex items-center gap-2">
          {passed > 0 && <span className="text-green">{passed} passed</span>}
          {failed > 0 && <span className="text-red">{failed} failed</span>}
          {running > 0 && <span className="text-yellow">{running} running</span>}
          {queued > 0 && <span className="text-dim">{queued} queued</span>}
        </span>
      }
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
      footerMeta={exitLabel(p.status, p.exit) ?? undefined}
    >
      <WidgetBody className="gap-0">
        {p.checks.map((c) => (
          <div
            key={c.name}
            className={cn(
              "flex items-center gap-2 rounded px-0.5 py-[1px]",
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
  // `checks` must be the sub-sub-command, not just present in the args:
  // `gh pr list --json checks` has "checks" as a JSON field name, not the
  // command, and `args.includes` would match it and pay for two failed regex
  // sweeps over the JSON. `args[1]` is the token right after `pr`.
  match: (c) => c.program === "gh" && c.sub === "pr" && c.args[1] === "checks",
  parse: parseCiChecks,
  render: (p) => <CiChecksWidget {...p} />
})
