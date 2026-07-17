import { Database } from "lucide-react"
import { CommandWidget, toneOf } from "../composites/command-widget.js"
import { DataGrid, type DataColumn } from "../components/data-grid.js"
import { StatusDot } from "../components/status-dot.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { exitLabel } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W4 — a query: what was asked, and the rows that came back. */

const CLIENTS = /^(psql|pgcli|mysql|sqlite3|duckdb)$/

export interface DbQueryProps {
  command: string
  status: ToolCallStatus
  /** The adapter-reported exit meta (codex\'s real code), or null. */
  exit: string | null
  /** Null for an interactive session or a heredoc — no inline SQL to echo. */
  sql: string | null
  columns: ReadonlyArray<DataColumn>
  rows: ReadonlyArray<ReadonlyArray<string>>
  /** What `(N rows)` claimed. Null under `-t`, where psql prints no trailer. */
  rowCount: number | null
  /** psql's command tag: `SELECT 4`, `INSERT 0 1`. */
  tag: string | null
  duration: string | null
}

/**
 * The SQL out of the *command*, not the output — a client echoes the query back
 * only in interactive mode, and by then it's indistinguishable from the result.
 *
 * `-e` alongside `-c` because the match list spans two dialects of the same
 * idea: postgres spells "run this and exit" `-c`, mysql spells it `-e`.
 */
const INLINE_SQL = /(?:^|\s)(?:-c|-e|--command)(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/

const sqlOf = (command: string): string | null => {
  const m = INLINE_SQL.exec(command)
  const sql = m?.[1] ?? m?.[2] ?? m?.[3] ?? null
  return sql?.trim() || null
}

/**
 * The invocation with the inline SQL lifted out — `psql $DATABASE_URL`.
 *
 * The header would otherwise show the query truncated to a useless fragment
 * (`psql … -c "select plan, count(*)…`) directly above the inset that shows the
 * same query in full, highlighted. Once the SQL has its own home, the header's
 * job is just to name the connection.
 */
const invocationOf = (command: string): string =>
  command.replace(INLINE_SQL, "").replace(/\s+/g, " ").trim()

/**
 * `------------+-------` — the rule under psql's header, and the anchor for the
 * whole parse: it is the one line whose shape is unambiguous, and it tells us
 * both where the header is (directly above) and where the rows start.
 */
const SEPARATOR = /^\s*-{2,}(?:\+-+)*\s*$/
/** `(4 rows)` / `(1 row)` — psql's row trailer, and the end of the grid. */
const ROW_TRAILER = /^\s*\((\d+)\s+rows?\)\s*$/
/**
 * `SELECT 4`, `INSERT 0 1`, `UPDATE 3` — the command tag psql prints for every
 * statement. Anchored to the whole line so a `SELECT` inside an echoed query
 * can't be mistaken for one.
 */
const COMMAND_TAG = /^(SELECT\s+\d+|INSERT\s+\d+\s+\d+|UPDATE\s+\d+|DELETE\s+\d+|COPY\s+\d+)\s*$/m
/**
 * `Time: 38.123 ms` — only printed with `\timing` on. Deliberately not
 * `scrapeDuration`: its looser patterns would happily read a duration out of a
 * *result cell*, and a query that wasn't timed must show no time at all.
 */
const TIMING = /^\s*Time:\s*([\d.]+\s*ms)\s*$/m

const cells = (line: string): string[] => line.split("|").map((c) => c.trim())

const NUMERIC = /^-?[\d,]+(?:\.\d+)?$/

/** A column is numeric only if every cell is — one `n/a` and the digits aren't the point. */
const isNumericColumn = (rows: ReadonlyArray<ReadonlyArray<string>>, i: number): boolean =>
  rows.length > 0 && rows.every((r) => r[i] !== undefined && NUMERIC.test(r[i]!))

/**
 * `8214` → `8,214`, but only when grouping can't misrepresent the value.
 *
 * Thousands separators help a COUNT and mangle an IDENTIFIER. Two things a
 * separator would corrupt, and how each is spotted:
 *   - a code with a LEADING ZERO — `02134` (a zip) → `02,134`. Never group.
 *   - a bare four-digit YEAR — `2026` → `2,026`. Left alone; five+ digits or a
 *     decimal are counts, and a four-digit count (`8214`) still groups because
 *     it's outside the 1900–2099 range we treat as a probable year.
 */
const YEAR = /^(?:19|20)\d\d$/
const group = (n: string): string => {
  const [int = "", frac] = n.replace(/,/g, "").split(".")
  const sign = int.startsWith("-") ? "-" : ""
  const digits = sign ? int.slice(1) : int
  const risky = digits.startsWith("0") || (frac === undefined && YEAR.test(digits))
  if (risky) return n.replace(/,/g, "")
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return frac !== undefined ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`
}

interface Grid {
  columns: DataColumn[]
  rows: string[][]
}

/**
 * psql's default aligned table.
 *
 * Under `-t` (tuples only) there is no header and no rule, so the grid is read
 * positionally instead and the columns are labelled by position — the database
 * didn't name them, and inventing names would be claiming knowledge we don't
 * have; a position at least is true.
 */
const gridOf = (out: string, tuplesOnly: boolean): Grid | null => {
  const lines = out.split("\n")
  const sep = lines.findIndex((l) => SEPARATOR.test(l))

  const start = sep > 0 ? sep + 1 : tuplesOnly ? 0 : -1
  if (start === -1) return null

  const rows: string[][] = []
  for (const line of lines.slice(start)) {
    if (line.trim() === "" || ROW_TRAILER.test(line) || COMMAND_TAG.test(line)) break
    rows.push(cells(line))
  }
  if (rows.length === 0) return null

  const width = Math.max(...rows.map((r) => r.length))
  const header = sep > 0 ? cells(lines[sep - 1]!) : []
  const columns: DataColumn[] = Array.from({ length: width }, (_, i) => ({
    key: header[i] ?? `col${i + 1}`,
    numeric: isNumericColumn(rows, i)
  }))

  return {
    columns,
    rows: rows.map((r) => columns.map((c, i) => (c.numeric ? group(r[i] ?? "") : (r[i] ?? ""))))
  }
}

export const parseDbQuery = (ctx: ParseContext): DbQueryProps | null => {
  const out = ctx.output
  // A query still in flight has no rows. A grid of nothing is worse than the
  // plain card, which at least says the command is running.
  if (!out) return null

  const tuplesOnly = /(?:^|\s)(?:-t|--tuples-only)(?:\s|$)/.test(ctx.command.primary)
  const grid = gridOf(out, tuplesOnly)
  // No rule, no rows: an error, a `\dt`, a psql banner — something we can't read
  // as a result set. Decline and let the log speak for itself.
  if (!grid) return null

  const trailer = ROW_TRAILER.exec(out.split("\n").find((l) => ROW_TRAILER.test(l)) ?? "")
  return {
    // The invocation only — the SQL lives in the inset, not twice.
    command: invocationOf(ctx.command.primary),
    status: ctx.status,
    exit: ctx.meta,
    sql: sqlOf(ctx.command.primary),
    columns: grid.columns,
    rows: grid.rows,
    rowCount: trailer?.[1] ? Number(trailer[1]) : null,
    tag: COMMAND_TAG.exec(out)?.[1]?.replace(/\s+/g, " ") ?? null,
    duration: TIMING.exec(out)?.[1]?.replace(/\s+/g, " ") ?? null
  }
}

/** The statements that only read. `read-only` is a claim about the query, so it
 *  is only made when there's a query to read it off. */
const READ_ONLY = /^\s*(select|show|explain)\b/i

export type SqlTokenKind = "keyword" | "function" | "table" | "number" | "string" | "punct" | "text"

export interface SqlToken {
  kind: SqlTokenKind
  text: string
}

/**
 * The ~30 words an agent's ad-hoc query actually uses. Not a SQL grammar: this
 * is a display nicety, and a keyword it doesn't know simply renders as text —
 * which is the right failure, because a *wrong* colour reads as a lie about the
 * query.
 */
const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset",
  "join", "left", "right", "inner", "outer", "on", "as", "and", "or", "not",
  "null", "is", "distinct", "insert", "into", "values", "update", "set",
  "delete", "asc", "desc", "union"
])

/** After these, the next word names a relation — the only reliable way to spot a
 *  table without a schema to consult. */
const RELATION_INTRODUCERS = new Set(["from", "join", "into", "update"])

const SCAN = /'(?:[^']|'')*'|"[^"]*"|\d+(?:\.\d+)?|[A-Za-z_][\w$]*|\s+|[^\sA-Za-z_'"\d]+/g

export const tokeniseSql = (sql: string): SqlToken[] => {
  const tokens: SqlToken[] = []
  let previousWord: string | null = null
  for (const m of sql.matchAll(SCAN)) {
    const text = m[0]
    if (/^\s/.test(text)) {
      tokens.push({ kind: "text", text })
      continue
    }
    if (/^['"]/.test(text)) {
      tokens.push({ kind: "string", text })
      continue
    }
    if (/^\d/.test(text)) {
      tokens.push({ kind: "number", text })
      continue
    }
    if (/^[A-Za-z_]/.test(text)) {
      const word = text.toLowerCase()
      // `count(` — a name applied to something is a function, whatever it's called.
      const called = sql[m.index + text.length] === "("
      const kind: SqlTokenKind = KEYWORDS.has(word)
        ? "keyword"
        : called
          ? "function"
          : previousWord !== null && RELATION_INTRODUCERS.has(previousWord)
            ? "table"
            : "text"
      tokens.push({ kind, text })
      previousWord = word
      continue
    }
    tokens.push({ kind: "punct", text })
  }
  return tokens
}

const TOKEN_TONE: Record<SqlTokenKind, string> = {
  keyword: "text-purple",
  function: "text-blue",
  table: "text-cyan",
  number: "text-orange",
  string: "text-green",
  punct: "text-dim",
  text: "text-text"
}

function Sql({ sql }: { sql: string }) {
  return (
    <pre className="whitespace-pre-wrap rounded-lg border border-line/25 bg-hairline px-3 py-2.5 font-mono text-[12px] leading-[1.7]">
      {tokeniseSql(sql).map((t, i) => (
        <span key={i} className={TOKEN_TONE[t.kind]}>
          {t.text}
        </span>
      ))}
    </pre>
  )
}

export function DbQueryWidget(p: DbQueryProps) {
  const rows = p.rowCount ?? p.rows.length
  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      // The database mark, next to the usual status glyph: a query card is
      // recognisable from across the transcript before a word of it is read.
      icon={
        <span className="flex flex-none items-center gap-[7px]">
          {p.status === "running" ? (
            <StatusDot tone="bg-yellow" size={9} pulse />
          ) : p.status === "error" ? (
            <span className="text-red">✗</span>
          ) : (
            <span className="text-green">✓</span>
          )}
          <Database size={14} className="text-muted-foreground" />
        </span>
      }
      headerMeta={p.sql && READ_ONLY.test(p.sql) ? <span className="text-dim">read-only</span> : undefined}
      footer={
        <span>
          <span className="text-text-bright">
            {rows.toLocaleString("en-US")} {rows === 1 ? "row" : "rows"}
          </span>
          {/* `\timing` off is the default, and then there is no time to show.
              The card says nothing rather than guessing at one. */}
          {p.duration && (
            <>
              <span className="text-dim"> · </span>
              {p.duration}
            </>
          )}
        </span>
      }
      footerMeta={<span className="text-dim">{p.tag ?? exitLabel(p.status, p.exit)}</span>}
    >
      {p.sql && (
        <div className="px-[15px] pt-[13px]">
          <Sql sql={p.sql} />
        </div>
      )}
      <div className="px-[15px] py-3">
        <DataGrid columns={p.columns} rows={p.rows} />
      </div>
    </CommandWidget>
  )
}

export const dbQueryWidget = defineWidget<DbQueryProps>({
  id: "db-query",
  /*
   * A client binary as its own TOKEN — not a raw substring. `c.raw.includes
   * ("psql")` claimed `grep -r psql docs/`, `cat notes/psql.md`, even `echo
   * 'run psql later'`, and gridOf is permissive enough that any output with a
   * `----` line then renders as a fabricated result grid. Matching a token also
   * still catches `docker compose exec db psql …`, which `program` alone misses.
   */
  match: (c) => CLIENTS.test(c.program) || c.tokens.some((t) => CLIENTS.test(t.replace(/^.*\//, ""))),
  parse: parseDbQuery,
  render: (p) => <DbQueryWidget {...p} />
})
