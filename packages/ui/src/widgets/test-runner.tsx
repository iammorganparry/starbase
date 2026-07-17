import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { FailureDetail } from "../components/failure-detail.js"
import { FileIcon } from "../components/file-icon.js"
import { SegmentedBar } from "../components/segmented-bar.js"
import { Spinner } from "../components/loading.js"
import { StatCount } from "../components/stat-count.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel, invokes, scrapeDuration } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W1 — a test suite: the scoreboard, the files, and the first thing that broke. */

const RUNNERS = /^(vitest|jest|playwright|ava|mocha|pytest)$/
/** `pnpm test`, `pnpm test:unit`, `npm t` — the script name is the signal. */
const TEST_SCRIPTS = /^(t|test|tests|test:[\w-]+)$/

export interface SuiteFile {
  path: string
  status: "pass" | "fail" | "running"
  /** Tests in this file; `"9/14"` while it's mid-run. */
  count: string
  duration: string | null
}

export interface SuiteFailure {
  title: string
  message: string | null
  at: string | null
}

export interface TestRunProps {
  command: string
  status: ToolCallStatus
  passed: number
  failed: number
  skipped: number
  /** Total the runner claims. Null → derive from the parts. */
  total: number | null
  fileCount: number | null
  files: ReadonlyArray<SuiteFile>
  failures: ReadonlyArray<SuiteFailure>
  duration: string | null
  watch: boolean
}

/** ` Tests  2 failed | 128 passed | 4 skipped (134)` — vitest's tail summary. */
const vitestCounts = (out: string) => {
  const m = /^\s*Tests\s+(.+?)\s*(?:\((\d+)\))?\s*$/m.exec(out)
  if (!m?.[1]) return null
  const part = (word: string) => {
    const p = new RegExp(`(\\d+)\\s+${word}`).exec(m[1]!)
    return p?.[1] ? Number(p[1]) : 0
  }
  return {
    passed: part("passed"),
    failed: part("failed"),
    skipped: part("skipped") + part("todo"),
    total: m[2] ? Number(m[2]) : null
  }
}

/** `Tests:  2 failed, 128 passed, 134 total` — jest's. */
const jestCounts = (out: string) => {
  const m = /^\s*Tests:\s+(.+)$/m.exec(out)
  if (!m?.[1]) return null
  const part = (word: string) => {
    const p = new RegExp(`(\\d+)\\s+${word}`).exec(m[1]!)
    return p?.[1] ? Number(p[1]) : 0
  }
  const total = part("total")
  return {
    passed: part("passed"),
    failed: part("failed"),
    skipped: part("skipped") + part("todo"),
    total: total || null
  }
}

const fileCountOf = (out: string): number | null => {
  const m = /^\s*Test (?:Files|Suites):\s+.*?\((\d+)\)\s*$/m.exec(out) ?? /^\s*Test Suites:.*?(\d+) total/m.exec(out)
  return m?.[1] ? Number(m[1]) : null
}

/**
 * Per-file lines: ` ✓ src/x.test.ts (22 tests) 420ms`.
 *
 * These stream out as the run proceeds, which is why the widget can show a
 * scoreboard before any summary line exists — and why a running suite still
 * renders once partial output arrives.
 */
/**
 * The `(?![:\w])` matters: vitest's stack frames are also `❯ path` lines
 * (`❯ src/db/migrate.test.ts:41:23`), and without it a failure's location gets
 * counted as a whole extra suite file.
 */
const FILE_LINE = /^\s*([✓✗×❯❌✔])\s+(\S+\.(?:test|spec)\.\w+)(?![:\w])(?:\s+\((\d+)\s+tests?(?:\s*\|\s*(\d+)\s+failed)?\))?(?:\s+([\d.]+\s*m?s))?/gm

const suiteFiles = (out: string): SuiteFile[] => {
  const files: SuiteFile[] = []
  for (const m of out.matchAll(FILE_LINE)) {
    const glyph = m[1]!
    const failed = glyph === "✗" || glyph === "×" || glyph === "❌"
    files.push({
      path: m[2]!,
      // `❯` is vitest's marker for a file still going.
      status: glyph === "❯" ? "running" : failed ? "fail" : "pass",
      count: m[4] ? m[4] : (m[3] ?? ""),
      duration: m[5]?.replace(/\s+/g, "") ?? null
    })
  }
  return files
}

/**
 * The failing assertions.
 *
 * Capped at three: the widget is a summary, and a suite with 40 failures wants
 * the header count plus a couple of examples, not a wall. The full log is one
 * click away in the generic view.
 */
const FAILURE_BLOCK = /(?:^|\n)\s*(?:FAIL|●)\s+(.+?)\n([\s\S]{0,400}?)(?=\n\s*(?:FAIL|●|Test Files|Tests:|$))/g

const failures = (out: string): SuiteFailure[] => {
  const found: SuiteFailure[] = []
  for (const m of out.matchAll(FAILURE_BLOCK)) {
    if (found.length >= 3) break
    const body = m[2] ?? ""
    const msg = /^\s*(?:AssertionError|Error|expected)\b.*$/im.exec(body)?.[0]?.trim() ?? null
    const at = /^\s*(?:❯|at)\s+(\S+:\d+:\d+)/m.exec(body)?.[1] ?? null
    found.push({ title: m[1]!.trim(), message: msg, at })
  }
  return found
}

export const parseTestRun = (ctx: ParseContext): TestRunProps | null => {
  const out = ctx.output
  // A suite that hasn't printed yet has no scoreboard to show. Fall back to the
  // plain card rather than render an empty widget claiming zero tests.
  if (!out) return null

  const counts = vitestCounts(out) ?? jestCounts(out)
  const files = suiteFiles(out)
  // Neither a summary nor a single recognisable file line: this isn't output we
  // understand. Decline.
  if (!counts && files.length === 0) return null

  const derived = counts ?? { passed: 0, failed: 0, skipped: 0, total: null }
  return {
    command: ctx.command.primary,
    status: ctx.status,
    ...derived,
    fileCount: fileCountOf(out) ?? (files.length || null),
    files,
    failures: failures(out),
    duration: scrapeDuration(out),
    watch: /watch/i.test(ctx.command.raw) || /press\s+\w\s+to/i.test(out)
  }
}

const glyphFor = (s: SuiteFile["status"]) =>
  s === "running" ? (
    <Spinner size={12} tone="working" />
  ) : (
    <span className={cn("w-3 text-center", s === "fail" ? "text-red" : "text-green")}>
      {s === "fail" ? "✗" : "✓"}
    </span>
  )

export function TestRunWidget(p: TestRunProps) {
  const done = p.passed + p.failed + p.skipped
  const remaining = p.total !== null ? Math.max(0, p.total - done) : 0
  const running = p.status === "running"
  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      headerMeta={
        running ? (
          <span className="text-yellow">running{p.duration && ` · ${p.duration}`}</span>
        ) : p.failed > 0 ? (
          <span className="text-red">
            {p.failed} failed
          </span>
        ) : (
          <span className="text-dim">{p.duration}</span>
        )
      }
      footer={
        p.watch ? (
          <span className="flex items-center gap-2">
            <span className="text-yellow">◆</span> watch mode · reruns on save
          </span>
        ) : p.duration ? (
          <span className={p.failed > 0 ? "text-red" : "text-green"}>
            {p.failed > 0 ? `${p.failed} failed` : "all passed"} · {p.duration}
          </span>
        ) : undefined
      }
      footerMeta={exitLabel(p.status) ?? undefined}
    >
      <WidgetBody className="gap-[14px]">
        <div className="flex items-end gap-[22px]">
          <StatCount value={p.passed} label="passed" tone="green" />
          <StatCount value={p.failed} label="failed" tone={p.failed > 0 ? "red" : "dim"} />
          <StatCount value={p.skipped} label="skipped" tone="dim" />
          <div className="flex-1" />
          <span className="text-right font-mono text-[11px] leading-[1.5] text-muted-foreground">
            {p.total !== null && (
              <>
                {done}
                <span className="text-dim"> / {p.total} tests</span>
                <br />
              </>
            )}
            {p.fileCount !== null && <span className="text-dim">{p.fileCount} files</span>}
          </span>
        </div>

        <SegmentedBar
          segments={[
            { value: p.passed, tone: "bg-green", label: `${p.passed} passed` },
            { value: p.failed, tone: "bg-red", label: `${p.failed} failed` },
            { value: p.skipped, tone: "bg-line", label: `${p.skipped} skipped` },
            { value: remaining, tone: "bg-surface", label: "remaining", shine: running }
          ]}
        />

        {p.files.length > 0 && (
          <div className="flex flex-col gap-px font-mono">
            {p.files.map((f) => (
              <div
                key={f.path}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-0.5 py-1.5 text-[12px]",
                  f.status === "running" && "bg-blue/[0.05]"
                )}
              >
                {glyphFor(f.status)}
                <FileIcon path={f.path} size={14} />
                <span className={cn("min-w-0 flex-1 truncate", f.status === "pass" ? "text-text" : "text-text-bright")}>
                  {f.path}
                </span>
                {f.count && (
                  <span className={f.status === "fail" ? "text-red" : f.status === "running" ? "text-yellow" : "text-green"}>
                    {f.count}
                  </span>
                )}
                <span className="w-12 text-right text-dim">{f.duration ?? "…"}</span>
              </div>
            ))}
          </div>
        )}

        {p.failures.map((f, i) => (
          <FailureDetail key={i} title={<>✗ {f.title}</>}>
            {f.message}
            {f.at && (
              <>
                <br />
                <span className="text-dim">at {f.at}</span>
              </>
            )}
          </FailureDetail>
        ))}
      </WidgetBody>
    </CommandWidget>
  )
}

export const testRunnerWidget = defineWidget<TestRunProps>({
  id: "test-runner",
  match: (c) =>
    invokes(c, RUNNERS) ||
    (c.sub !== null && TEST_SCRIPTS.test(c.sub)) ||
    (c.program === "go" && c.sub === "test") ||
    (c.program === "cargo" && c.sub === "test"),
  parse: parseTestRun,
  render: (p) => <TestRunWidget {...p} />
})
