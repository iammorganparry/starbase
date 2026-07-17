import { CommandWidget, toneOf } from "../composites/command-widget.js"
import { FileIcon } from "../components/file-icon.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel, invokes } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W6 — a broken build: every complaint, filed under the file that caused it. */

const CHECKERS = /^(tsc|eslint|biome|ruff|oxlint|stylelint)$/
const CHECK_SCRIPTS = /^(lint|lint:fix|typecheck|types|check|check:types)$/

export type Severity = "error" | "warning"

export interface Diagnostic {
  line: number
  col: number
  severity: Severity
  message: string
  /** `ts(18048)`, `no-unsafe-optional-chaining`. Null when the tool named no rule. */
  code: string | null
}

export interface DiagnosticFile {
  path: string
  diagnostics: ReadonlyArray<Diagnostic>
}

export interface DiagnosticsProps {
  command: string
  status: ToolCallStatus
  files: ReadonlyArray<DiagnosticFile>
  errorCount: number
  warningCount: number
}

/** `src/api/webhook.ts(41,12): error TS18048: 'payload' is possibly 'undefined'.` */
const TSC_LINE = /^(\S[^(\n]*?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.+?)\s*$/gim

/** eslint stylish files its diagnostics under a bare path on its own line. */
const ESLINT_FILE = /^(\/?[\w.@~-]+(?:[/\\][\w.@ -]+)*\.\w+)\s*$/
/** `  41:12  error    'payload' is possibly undefined  no-unsafe-optional-chaining` */
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s*$/i
/** eslint puts 2+ spaces between the message and the rule id; a rule id has none. */
const ESLINT_RULE = /^(.+?)\s{2,}([\w@][\w@/.-]*)$/

/** `Found 3 errors in 2 files.` / `✖ 3 problems (2 errors, 1 warning)` */
const TSC_TOTAL = /\bFound\s+(\d+)\s+errors?\b/i
const ESLINT_TOTAL = /\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i

/** `TS18048` → `ts(18048)`, the form both tsc's own docs and editors use. */
const tsCode = (raw: string): string => {
  const m = /^([A-Z]+)(\d+)$/.exec(raw)
  return m ? `${m[1]!.toLowerCase()}(${m[2]})` : raw
}

interface Found {
  path: string
  diagnostic: Diagnostic
}

const tscDiagnostics = (out: string): Found[] =>
  [...out.matchAll(TSC_LINE)].map((m) => ({
    path: m[1]!,
    diagnostic: {
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4]!.toLowerCase() as Severity,
      message: m[6]!,
      code: tsCode(m[5]!)
    }
  }))

const eslintDiagnostics = (out: string): Found[] => {
  const found: Found[] = []
  let path: string | null = null
  for (const line of out.split("\n")) {
    const row = ESLINT_ROW.exec(line)
    if (row && path) {
      const rest = row[4]!
      const split = ESLINT_RULE.exec(rest)
      found.push({
        path,
        diagnostic: {
          line: Number(row[1]),
          col: Number(row[2]),
          severity: row[3]!.toLowerCase() as Severity,
          message: split ? split[1]! : rest,
          code: split ? split[2]! : null
        }
      })
      continue
    }
    // A bare path opens a new group; anything else (a blank line, the summary)
    // just ends the current one.
    const file = ESLINT_FILE.exec(line)
    path = file ? file[1]! : line.trim() === "" ? path : null
  }
  return found
}

/** Directory names that read as project-relative rather than machine-specific. */
const SOURCE_ROOT = /^(src|app|apps|lib|libs|packages|test|tests|source)$/

/**
 * The machine-specific prefix, dropped from every path.
 *
 * Two guards, both about not over-stripping. Only with two or more files: one
 * absolute path is no evidence of where the root is, and cutting its whole
 * directory leaves a bare basename with less information than we started with.
 * And the walk halts at `src`/`packages`/…: eslint prints absolute paths, and
 * every diagnostic in one run often shares `…/repo/src`, but `src/api/x.ts` is
 * how the reader refers to the file — `api/x.ts` is a path to nowhere.
 */
const stripCommonRoot = (paths: string[]): string[] => {
  if (paths.length < 2 || !paths.every((p) => p.startsWith("/"))) return paths
  const split = paths.map((p) => p.split("/"))
  const first = split[0]!
  let shared = 0
  // `- 1`: the last segment is the filename, never part of the root.
  while (
    shared < first.length - 1 &&
    !SOURCE_ROOT.test(first[shared]!) &&
    split.every((s) => shared < s.length - 1 && s[shared] === first[shared])
  ) {
    shared++
  }
  if (shared === 0) return paths
  return split.map((s) => s.slice(shared).join("/"))
}

export const parseDiagnostics = (ctx: ParseContext): DiagnosticsProps | null => {
  const out = ctx.output
  // Still running, or a clean run that printed nothing: there is no list of
  // problems to file. Let the plain card say so.
  if (!out) return null

  const found = [...tscDiagnostics(out), ...eslintDiagnostics(out)]
  if (found.length === 0) return null

  const paths = stripCommonRoot(found.map((f) => f.path))
  const files: DiagnosticFile[] = []
  const index = new Map<string, Diagnostic[]>()
  found.forEach((f, i) => {
    const path = paths[i]!
    let bucket = index.get(path)
    if (!bucket) {
      bucket = []
      index.set(path, bucket)
      // First-seen order: the tool reported in the order it walked, which is the
      // order the reader will go looking.
      files.push({ path, diagnostics: bucket })
    }
    bucket.push(f.diagnostic)
  })

  /*
   * Prefer the tool's own totals over ours. The adapter elides the middle of a
   * long log, so a broken build's rows are the ones we can see — but its summary
   * line survives in the tail, and it knows the true count.
   */
  const eslintTotal = ESLINT_TOTAL.exec(out)
  const tscTotal = TSC_TOTAL.exec(out)
  const errors = found.filter((f) => f.diagnostic.severity === "error").length
  const warnings = found.length - errors
  return {
    command: ctx.command.primary,
    status: ctx.status,
    files,
    errorCount: eslintTotal ? Number(eslintTotal[1]) : tscTotal ? Number(tscTotal[1]) : errors,
    warningCount: eslintTotal ? Number(eslintTotal[2]) : warnings
  }
}

/** A broken build prints hundreds. Show the first dozen and count the rest. */
const MAX_ROWS = 12

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function DiagnosticsWidget(p: DiagnosticsProps) {
  const total = p.files.reduce((n, f) => n + f.diagnostics.length, 0)
  let budget = MAX_ROWS
  const groups = p.files
    .map((f) => {
      const rows = f.diagnostics.slice(0, budget)
      budget -= rows.length
      return { path: f.path, rows }
    })
    .filter((g) => g.rows.length > 0)
  const hidden = total - MAX_ROWS

  return (
    <CommandWidget
      // The exit code can lie by omission — `eslint --max-warnings 0` exits 1 on
      // warnings alone. The diagnostics themselves are the truth about the tone.
      tone={p.errorCount > 0 ? "failed" : toneOf(p.status)}
      command={p.command}
      headerMeta={
        p.errorCount > 0 ? (
          <span className="text-red">{plural(p.errorCount, "error")}</span>
        ) : (
          <span className="text-yellow">{plural(p.warningCount, "warning")}</span>
        )
      }
      footer={
        <span className="flex items-center gap-1.5">
          {p.errorCount > 0 && <span className="text-red">{plural(p.errorCount, "error")}</span>}
          {p.warningCount > 0 && <span className="text-yellow">{plural(p.warningCount, "warning")}</span>}
          <span className="text-dim">· {plural(p.files.length, "file")}</span>
        </span>
      }
      footerMeta={
        exitLabel(p.status) ? (
          <span className={p.status === "error" ? "text-red" : "text-dim"}>{exitLabel(p.status)}</span>
        ) : undefined
      }
    >
      <div className="flex flex-col px-2 py-1.5 font-mono">
        {groups.map((g, i) => (
          <div key={g.path} className={cn(i > 0 && "mt-0.5 border-t border-line/25")}>
            <div className="flex items-center gap-[7px] px-2 pt-2 pb-[5px] text-[11.5px] leading-[1.5] text-cyan">
              <FileIcon path={g.path} size={13} />
              <span className="min-w-0 truncate">{g.path}</span>
            </div>
            {g.rows.map((d, j) => (
              <div key={j} className="flex items-baseline gap-2.5 px-2 py-1 text-[11.5px] leading-[1.5]">
                <span className="w-11 flex-none text-dim">
                  {d.line}:{d.col}
                </span>
                <span className={cn("flex-none", d.severity === "error" ? "text-red" : "text-yellow")}>
                  {d.severity}
                </span>
                <span className="min-w-0 flex-1 text-text">{d.message}</span>
                {d.code && <span className="flex-none text-dim">{d.code}</span>}
              </div>
            ))}
          </div>
        ))}
        {hidden > 0 && <div className="px-2 py-1.5 text-[11.5px] leading-[1.5] text-dim">+{hidden} more</div>}
      </div>
    </CommandWidget>
  )
}

export const diagnosticsWidget = defineWidget<DiagnosticsProps>({
  id: "diagnostics",
  match: (c) => invokes(c, CHECKERS) || (c.sub !== null && CHECK_SCRIPTS.test(c.sub)),
  parse: parseDiagnostics,
  render: (p) => <DiagnosticsWidget {...p} />
})
