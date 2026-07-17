import { describe, expect, it } from "vitest"
import { parseCommand } from "./command.js"
import { dbQueryWidget, parseDbQuery, tokeniseSql } from "./db-query.js"

const QUERY = `psql $DATABASE_URL -c "select plan, count(*) from users where active group by plan order by 2 desc;"`

const ctx = (output: string | undefined, command = QUERY, status: "running" | "success" | "error" = "success") => ({
  command: parseCommand(command),
  output,
  status
})

const ALIGNED = `    plan    | count
------------+-------
 free       |  8214
 pro        |  1902
 team       |   486
 enterprise |    41
(4 rows)

SELECT 4
Time: 38.123 ms
`

const matches = (command: string) => dbQueryWidget.match(parseCommand(command))

describe("classify", () => {
  it.each(["psql -c 'select 1'", "pgcli mydb", "mysql -e 'select 1'", "sqlite3 dev.db", "duckdb", "cd api && psql $DATABASE_URL"])(
    "claims %j",
    (cmd) => {
      expect(matches(cmd)).toBe(true)
    }
  )

  it.each(["vitest run", "git status", "curl https://api.trigify.io"])("leaves %j to another widget", (cmd) => {
    expect(matches(cmd)).toBe(false)
  })
})

describe("parseDbQuery", () => {
  it("reads the aligned grid psql prints by default", () => {
    const p = parseDbQuery(ctx(ALIGNED))!
    expect(p.columns.map((c) => c.key)).toEqual(["plan", "count"])
    expect(p.rows).toHaveLength(4)
    expect(p.rows[0]).toEqual(["free", "8,214"])
  })

  it("marks the all-digits column numeric and groups its thousands", () => {
    const p = parseDbQuery(ctx(ALIGNED))!
    expect(p.columns[0]!.numeric).toBe(false)
    expect(p.columns[1]!.numeric).toBe(true)
    expect(p.rows[1]).toEqual(["pro", "1,902"])
    expect(p.rows[3]).toEqual(["enterprise", "41"])
  })

  it("takes the row count, command tag and timing from the trailer", () => {
    const p = parseDbQuery(ctx(ALIGNED))!
    expect(p.rowCount).toBe(4)
    expect(p.tag).toBe("SELECT 4")
    expect(p.duration).toBe("38.123 ms")
  })

  it("reports no timing when \\timing was never switched on", () => {
    const p = parseDbQuery(ctx(ALIGNED.replace("Time: 38.123 ms", "")))!
    expect(p.duration).toBeNull()
  })

  it("echoes the SQL from the command, where the only copy of it lives", () => {
    expect(parseDbQuery(ctx(ALIGNED))!.sql).toBe(
      "select plan, count(*) from users where active group by plan order by 2 desc;"
    )
  })

  it.each([
    [`psql -c 'select 1;'`, "select 1;"],
    [`psql --command="select 1;"`, "select 1;"],
    [`mysql shop -e "select 1;"`, "select 1;"]
  ])("finds the inline SQL in %j", (cmd, sql) => {
    expect(parseDbQuery(ctx(ALIGNED, cmd))!.sql).toBe(sql)
  })

  it("still renders the grid for an interactive session with no inline SQL", () => {
    const p = parseDbQuery(ctx(ALIGNED, "psql $DATABASE_URL"))!
    expect(p.sql).toBeNull()
    expect(p.rows).toHaveLength(4)
  })

  it("reads a tuples-only result, labelling the columns it was given no names for", () => {
    const p = parseDbQuery(ctx(" free       |  8214\n pro        |  1902\n", `psql -t -c "select plan, count(*) from users"`))!
    expect(p.columns.map((c) => c.key)).toEqual(["col1", "col2"])
    expect(p.rows).toEqual([
      ["free", "8,214"],
      ["pro", "1,902"]
    ])
    expect(p.rowCount).toBeNull()
  })

  it("declines while the query is still running, rather than showing an empty grid", () => {
    expect(parseDbQuery(ctx(undefined, QUERY, "running"))).toBeNull()
  })

  it("declines output with no separator rule, so the plain card still shows it", () => {
    expect(parseDbQuery(ctx('psql: error: connection to server failed', QUERY, "error"))).toBeNull()
  })

  it("declines a rule with no rows under it", () => {
    expect(parseDbQuery(ctx("    plan    | count \n------------+-------\n(0 rows)\n"))).toBeNull()
  })
})

describe("tokeniseSql", () => {
  const kindOf = (sql: string, text: string) => tokeniseSql(sql).find((t) => t.text === text)?.kind

  it("colours keywords, the counted function, the table and the numbers apart", () => {
    const sql = "select plan, count(*) from users where active group by plan order by 2 desc;"
    expect(kindOf(sql, "select")).toBe("keyword")
    expect(kindOf(sql, "group")).toBe("keyword")
    expect(kindOf(sql, "desc")).toBe("keyword")
    expect(kindOf(sql, "count")).toBe("function")
    expect(kindOf(sql, "users")).toBe("table")
    expect(kindOf(sql, "2")).toBe("number")
    expect(kindOf(sql, ";")).toBe("punct")
  })

  it("leaves a word it has no reading of as plain text", () => {
    expect(kindOf("select plan from users", "plan")).toBe("text")
  })

  it("keeps string literals whole, quotes and all", () => {
    expect(tokeniseSql("select * from users where plan = 'pro'").find((t) => t.kind === "string")?.text).toBe("'pro'")
  })

  it("round-trips the query exactly, so highlighting can never rewrite it", () => {
    const sql = "select plan, count(*) from users where active group by plan order by 2 desc;"
    expect(tokeniseSql(sql).map((t) => t.text).join("")).toBe(sql)
  })
})

describe("the header invocation", () => {
  it("lifts the inline SQL out, so the header names the connection and the inset owns the query", () => {
    const p = parseDbQuery({
      command: parseCommand(`psql $DATABASE_URL -c "select plan, count(*) from users;"`),
      output: " plan | count\n------+-------\n free |  8214\n(1 row)",
      status: "success"
    })!
    expect(p.command).toBe("psql $DATABASE_URL")
    expect(p.sql).toBe("select plan, count(*) from users;")
  })
})
