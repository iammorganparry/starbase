import type { Message, ToolCall as ToolCallModel } from "@starbase/core"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MessageTurn } from "../composites/message-turn.js"

/**
 * The command widgets, end to end.
 *
 * These drive the whole path a real bash call takes — a `ToolCall` off the wire,
 * through `MessageTurn` → `ToolCardView` → the registry → a widget → the DOM.
 * The parse tests next door prove each parser reads its format; these prove the
 * right widget is CHOSEN for the command and that what it read reaches the
 * screen. A parser can be perfect and still never render.
 *
 * Every case asserts the widget's identity via `data-command-widget`, not by
 * text. Text alone can't distinguish "the build widget rendered" from "the
 * generic card rendered and happens to contain a file size" — and a widget
 * quietly degrading to the fallback is the exact regression worth catching.
 */

afterEach(cleanup)

const bash = (target: string, output?: string, status: ToolCallModel["status"] = "success"): Message => ({
  id: "m1",
  role: "assistant",
  streaming: false,
  createdAt: "2026-07-17T10:00:00.000Z",
  parts: [
    {
      _tag: "Tool",
      tool: { id: "t1", name: "Bash", target, status, meta: null, diff: null, preview: null, ...(output !== undefined ? { output } : {}) } as ToolCallModel
    }
  ]
})

/** Which spec took the command, straight off the rendered DOM. */
const widgetIn = (c: HTMLElement): string | null =>
  c.querySelector("[data-command-widget]")?.getAttribute("data-command-widget") ?? null

const show = (target: string, output?: string, status: ToolCallModel["status"] = "success") =>
  render(<MessageTurn message={bash(target, output, status)} />)

// ── Fixtures: output as these tools actually print it ──────────────────────────

const VITEST = `
 ✓ src/auth/session.test.ts (22 tests) 420ms
 ✗ src/db/migrate.test.ts (2 tests | 2 failed) 810ms

 FAIL  src/db/migrate.test.ts > migrate > applies pending migrations in order
AssertionError: expected 4 to equal 3
 ❯ src/db/migrate.test.ts:41:23

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 128 passed | 4 skipped (134)
   Duration  3.20s
`
const GH_CHECKS = `build\tpass\t1m4s\thttps://x/1
e2e-playwright\tpending\t2m12s\thttps://x/2
deploy-preview\tqueued\t\thttps://x/3`

const PNPM_INSTALL = `Packages: +12 -3
Progress: resolved 412, reused 400, downloaded 12, added 12, done

dependencies:
+ zod 3.23.8
- jest 29.7.0

Done in 6.3s`

const PSQL = `    plan    | count
------------+-------
 free       |  8214
 pro        |  1902
(2 rows)`

const VITE_BUILD = `vite v5.3.1 building for production...
✓ 1284 modules transformed.
dist/assets/index-c3d4.js       246.80 kB │ gzip:  78.20 kB
dist/assets/vendor-e5f6.js      512.10 kB │ gzip: 168.00 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
✓ built in 4.12s`

const TSC = `src/api/webhook.ts(41,12): error TS18048: 'payload' is possibly 'undefined'.
src/billing/refund.ts(22,19): error TS2345: Type 'string' is not assignable to parameter of type 'number'.

Found 2 errors in 2 files.`

const VITE_DEV = `
  VITE v5.3.1  ready in 412 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.24:5173/
`
const CURL = `HTTP/2 200
content-type: application/json

{"id":"cus_9f4a2b8e","matched":true}`

const GIT = `[feat/oauth 3af12e9] fix: guard webhook payload
 3 files changed, 47 insertions(+), 12 deletions(-)
To github.com:trigify/starbase.git
   3af12e9..9d4c1a2  feat/oauth -> feat/oauth`

// ── W1 ────────────────────────────────────────────────────────────────────────

describe("W1 · test runner", () => {
  it("renders for `vitest run`", () => {
    const { container } = show("vitest run", VITEST, "error")
    expect(widgetIn(container)).toBe("test-runner")
  })

  it("puts the scoreboard on screen", () => {
    show("vitest run", VITEST, "error")
    expect(screen.getByText("128")).toBeDefined()
    expect(screen.getByText("passed")).toBeDefined()
    expect(screen.getByText("4")).toBeDefined()
    expect(screen.getByText("skipped")).toBeDefined()
  })

  it("names each suite file and its outcome", () => {
    show("vitest run", VITEST, "error")
    expect(screen.getByText("src/auth/session.test.ts")).toBeDefined()
    expect(screen.getByText("src/db/migrate.test.ts")).toBeDefined()
  })

  it("shows the failing assertion and where it happened", () => {
    show("vitest run", VITEST, "error")
    expect(screen.getByText(/applies pending migrations in order/)).toBeDefined()
    expect(screen.getByText(/expected 4 to equal 3/)).toBeDefined()
    expect(screen.getByText(/migrate\.test\.ts:41:23/)).toBeDefined()
  })

  it("reaches the same widget from `pnpm test` and a filtered workspace run", () => {
    expect(widgetIn(show("pnpm test", VITEST, "error").container)).toBe("test-runner")
    cleanup()
    expect(widgetIn(show("pnpm --filter @starbase/ui test", VITEST, "error").container)).toBe("test-runner")
  })
})

// ── W2 ────────────────────────────────────────────────────────────────────────

describe("W2 · CI checks", () => {
  it("renders for `gh pr checks`", () => {
    const { container } = show("gh pr checks 482 --watch", GH_CHECKS, "running")
    expect(widgetIn(container)).toBe("ci-checks")
  })

  it("lists every check with its state", () => {
    show("gh pr checks 482 --watch", GH_CHECKS, "running")
    expect(screen.getByText("build")).toBeDefined()
    expect(screen.getByText("e2e-playwright")).toBeDefined()
    expect(screen.getByText("deploy-preview")).toBeDefined()
  })

  it("shows the PR number from the command", () => {
    show("gh pr checks 482 --watch", GH_CHECKS, "running")
    expect(screen.getByText("#482")).toBeDefined()
  })

  it("tallies each state under its own name, agreeing with the rows", () => {
    // The footer used to lump queued+skipped+cancelled under "waiting", which
    // contradicted the row beside it.
    show("gh pr checks 482 --watch", GH_CHECKS, "running")
    expect(screen.getByText(/1 queued/)).toBeDefined()
    expect(screen.queryByText(/waiting/)).toBeNull()
  })
})

// ── W3 ────────────────────────────────────────────────────────────────────────

describe("W3 · package install", () => {
  it("renders for `pnpm install`", () => {
    expect(widgetIn(show("pnpm install", PNPM_INSTALL).container)).toBe("package-install")
  })

  it("shows the dependency delta", () => {
    show("pnpm install", PNPM_INSTALL)
    expect(screen.getByText("zod")).toBeDefined()
    expect(screen.getByText("3.23.8")).toBeDefined()
    expect(screen.getByText("jest")).toBeDefined()
  })

  it("renders for `pnpm add` and `npm install` too", () => {
    expect(widgetIn(show("pnpm add zod", PNPM_INSTALL).container)).toBe("package-install")
    cleanup()
    const npm = "added 12 packages, removed 3 packages, and audited 412 packages in 6s"
    expect(widgetIn(show("npm install", npm).container)).toBe("package-install")
  })
})

// ── W4 ────────────────────────────────────────────────────────────────────────

describe("W4 · database query", () => {
  const CMD = `psql $DATABASE_URL -c "select plan, count(*) from users group by plan;"`

  it("renders for psql", () => {
    expect(widgetIn(show(CMD, PSQL).container)).toBe("db-query")
  })

  it("puts the result grid on screen", () => {
    show(CMD, PSQL)
    expect(screen.getByText("free")).toBeDefined()
    // Grouped for reading — the raw output says 8214.
    expect(screen.getByText("8,214")).toBeDefined()
    expect(screen.getByText(/2 rows/)).toBeDefined()
  })

  it("shows the SQL once, in the inset, and names the connection in the header", () => {
    const { container } = show(CMD, PSQL)
    // The header must not repeat the query truncated to a useless fragment.
    expect(container.textContent).toContain("$DATABASE_URL")
    expect(screen.getAllByText(/select/i).length).toBe(1)
  })
})

// ── W5 ────────────────────────────────────────────────────────────────────────

describe("W5 · build", () => {
  it("renders for `pnpm build`", () => {
    expect(widgetIn(show("pnpm build", VITE_BUILD).container)).toBe("build")
  })

  it("lists the bundle with its gzip size", () => {
    show("pnpm build", VITE_BUILD)
    expect(screen.getByText("dist/assets/vendor-e5f6.js")).toBeDefined()
    expect(screen.getByText("512.10 kB")).toBeDefined()
    expect(screen.getByText("gzip 168.00 kB")).toBeDefined()
  })

  it("surfaces the warning without the dangling clause", () => {
    show("pnpm build", VITE_BUILD)
    expect(screen.getByText(/larger than 500 kB after minification/)).toBeDefined()
    expect(screen.queryByText(/Consider:/)).toBeNull()
  })

  it("reads `vite build` as a build, not as a dev server", () => {
    // Both specs match this command; precedence decides. A production build
    // drawn as a dev server would be a plausible-looking wrong answer.
    expect(widgetIn(show("vite build", VITE_BUILD).container)).toBe("build")
    cleanup()
    expect(widgetIn(show("next build", VITE_BUILD).container)).toBe("build")
  })
})

// ── W6 ────────────────────────────────────────────────────────────────────────

describe("W6 · diagnostics", () => {
  it("renders for `tsc --noEmit`", () => {
    expect(widgetIn(show("tsc --noEmit", TSC, "error").container)).toBe("diagnostics")
  })

  it("groups the errors under their files", () => {
    show("tsc --noEmit", TSC, "error")
    expect(screen.getByText("src/api/webhook.ts")).toBeDefined()
    expect(screen.getByText("src/billing/refund.ts")).toBeDefined()
    expect(screen.getByText(/'payload' is possibly 'undefined'/)).toBeDefined()
    expect(screen.getByText("41:12")).toBeDefined()
    expect(screen.getByText("ts(18048)")).toBeDefined()
  })

  it("renders for eslint's stylish format as well", () => {
    const eslint = `/repo/src/api/webhook.ts
  41:12  error    'payload' is possibly undefined  no-unsafe-optional-chaining

✖ 1 problem (1 error, 0 warnings)`
    expect(widgetIn(show("pnpm lint", eslint, "error").container)).toBe("diagnostics")
  })

  it("routes `pnpm typecheck` here, not to the build widget", () => {
    expect(widgetIn(show("pnpm typecheck", TSC, "error").container)).toBe("diagnostics")
  })
})

// ── W7 ────────────────────────────────────────────────────────────────────────

describe("W7 · dev server", () => {
  it("renders for `pnpm dev`", () => {
    expect(widgetIn(show("pnpm dev", VITE_DEV, "running").container)).toBe("dev-server")
  })

  it("makes the local URL a real link", () => {
    show("pnpm dev", VITE_DEV, "running")
    const link = screen.getByRole("link", { name: /localhost:5173/ })
    expect(link.getAttribute("href")).toBe("http://localhost:5173/")
  })

  it("says it is listening while it runs", () => {
    show("pnpm dev", VITE_DEV, "running")
    expect(screen.getByText("listening")).toBeDefined()
  })

  it("claims no uptime, having no honest source for one", () => {
    const { container } = show("pnpm dev", VITE_DEV, "running")
    expect(container.textContent).not.toMatch(/uptime/i)
  })

  it("reads bare `vite` as the dev server", () => {
    expect(widgetIn(show("vite", VITE_DEV, "running").container)).toBe("dev-server")
  })

  it("falls back to the plain card before it has printed anything", () => {
    // A long-running server prints nothing until it exits, so today this is the
    // common case. An empty dev-server widget would be worse than the log.
    const { container } = show("pnpm dev", undefined, "running")
    expect(widgetIn(container)).toBe("generic")
  })
})

// ── W8 ────────────────────────────────────────────────────────────────────────

describe("W8 · HTTP request", () => {
  it("renders for curl", () => {
    expect(widgetIn(show("curl -s -i -X POST https://api.trigify.io/v1/enrich", CURL).container)).toBe("http-request")
  })

  it("shows the method, url, status and body", () => {
    show("curl -s -i -X POST https://api.trigify.io/v1/enrich", CURL)
    expect(screen.getByText("https://api.trigify.io/v1/enrich")).toBeDefined()
    expect(screen.getByText(/cus_9f4a2b8e/)).toBeDefined()
    // "POST" and "200 OK" each appear twice by design — once echoed in the
    // command line, once as the body's own method row / status pill.
    expect(screen.getAllByText("POST").length).toBeGreaterThan(0)
    expect(screen.getAllByText("200 OK")).toHaveLength(2)
  })

  it("renders a bare body with no status line — the common case", () => {
    const { container } = show("curl -s https://api.trigify.io/v1/me", `{"plan":"team"}`)
    expect(widgetIn(container)).toBe("http-request")
    expect(screen.getByText(/team/)).toBeDefined()
  })

  it("shows a non-JSON body raw rather than half-highlighted", () => {
    const { container } = show("curl -s https://example.com/health", "OK")
    expect(widgetIn(container)).toBe("http-request")
    expect(screen.getByText("OK")).toBeDefined()
  })
})

// ── W9 ────────────────────────────────────────────────────────────────────────

describe("W9 · git", () => {
  const CMD = "git commit -m 'fix: guard webhook payload' && git push"

  it("renders for a commit and push", () => {
    expect(widgetIn(show(CMD, GIT).container)).toBe("git-op")
  })

  it("shows the branch, sha, subject and the diff summary", () => {
    const { container } = show(CMD, GIT)
    expect(screen.getByText("3af12e9")).toBeDefined()
    expect(screen.getByText(/3 files changed/)).toBeDefined()
    expect(screen.getByText("+47")).toBeDefined()
    expect(screen.getByText("−12")).toBeDefined()
    // The subject appears twice: echoed in the `-m` argument, and as the commit
    // line git printed back. Both are the truth; assert on the parsed one.
    expect(container.querySelector("[data-command-widget]")!.textContent).toContain("[feat/oauth 3af12e9]")
  })

  it("leaves `git status` to the plain card — there is no summary to draw", () => {
    const { container } = show("git status", " M src/a.ts\n?? src/b.ts")
    expect(widgetIn(container)).toBe("generic")
  })
})

// ── W10 ───────────────────────────────────────────────────────────────────────

describe("W10 · generic", () => {
  const SEED = "connecting to postgres…\n✓ seeded 8,214 users\nwarn skipped 3 rows"

  it("takes any command nothing else claims", () => {
    expect(widgetIn(show("./scripts/seed.sh", SEED).container)).toBe("generic")
    cleanup()
    expect(widgetIn(show("ls -la", "a\nb").container)).toBe("generic")
  })

  it("stays a one-liner until asked, then shows the log", () => {
    show("./scripts/seed.sh", SEED)
    expect(screen.queryByText(/seeded 8,214 users/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText(/seeded 8,214 users/)).toBeDefined()
  })

  it("summarises the outcome while still collapsed", () => {
    show("./scripts/seed.sh", SEED)
    expect(screen.getByText(/exit 0 · 3 lines/)).toBeDefined()
  })

  it("says when the middle was elided, rather than passing a cut log off as whole", () => {
    show("./scripts/noisy.sh", "line 1\n\n… 4,096 characters omitted …\n\nline 999")
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText(/middle elided/)).toBeDefined()
  })
})

// ── The seam itself ───────────────────────────────────────────────────────────

describe("the bash seam", () => {
  it("leaves non-bash tools on the plain card", () => {
    const { container } = render(
      <MessageTurn
        message={{
          ...bash("x"),
          parts: [
            {
              _tag: "Tool",
              tool: {
                id: "t1",
                name: "Read",
                target: "/repo/src/a.ts",
                status: "success",
                meta: "142 lines",
                diff: null,
                preview: null
              } as ToolCallModel
            }
          ]
        }}
      />
    )
    expect(widgetIn(container)).toBeNull()
    expect(screen.getByText("a.ts")).toBeDefined()
  })

  it("renders one widget per bash call in a turn", () => {
    const { container } = render(
      <MessageTurn
        message={{
          ...bash("x"),
          parts: [
            { _tag: "Tool", tool: { id: "1", name: "Bash", target: "vitest run", status: "error", meta: null, diff: null, preview: null, output: VITEST } as ToolCallModel },
            { _tag: "Text", text: "Now the build." },
            { _tag: "Tool", tool: { id: "2", name: "Bash", target: "pnpm build", status: "success", meta: null, diff: null, preview: null, output: VITE_BUILD } as ToolCallModel }
          ]
        }}
      />
    )
    const ids = [...container.querySelectorAll("[data-command-widget]")].map((n) =>
      n.getAttribute("data-command-widget")
    )
    expect(ids).toEqual(["test-runner", "build"])
  })

  it("never leaves a bash call unrendered, whatever it printed", () => {
    // generic matches everything and never declines, so there is always a card.
    for (const [cmd, out] of [
      ["", "x"],
      ["   ", ""],
      ["¯\\_(ツ)_/¯", "?!"],
      ["vitest run", "  garbage"],
      ["psql -c 'select 1'", "ERROR: relation does not exist"]
    ] as const) {
      const { container } = render(<MessageTurn message={bash(cmd, out, "error")} />)
      expect(within(container).getByText((_, el) => el?.tagName === "BUTTON" || false, { selector: "*" })).toBeDefined()
      cleanup()
    }
  })
})

// ── Across harnesses ──────────────────────────────────────────────────────────

describe("every harness's bash call", () => {
  /**
   * Starbase runs three harnesses and they disagree about where a tool's output
   * goes. claude and codex fill `output`; opencode fills `preview` instead. The
   * widgets must not care.
   */
  const opencodeBash = (target: string, preview: string): Message => ({
    id: "m1",
    role: "assistant",
    streaming: false,
    createdAt: "2026-07-17T10:00:00.000Z",
    parts: [
      {
        _tag: "Tool",
        tool: { id: "t1", name: "Bash", target, status: "success", meta: null, diff: null, preview } as ToolCallModel
      }
    ]
  })

  it("reads output the opencode adapter reported as `preview`", () => {
    // Without this the card renders "No output." while the log sits one field
    // away — every opencode bash call silently loses what it printed.
    const { container } = render(<MessageTurn message={opencodeBash("vitest run", VITEST)} />)
    expect(widgetIn(container)).toBe("test-runner")
    expect(screen.getByText("128")).toBeDefined()
  })

  it("still reads output the claude and codex adapters report as `output`", () => {
    const { container } = show("vitest run", VITEST, "error")
    expect(widgetIn(container)).toBe("test-runner")
    expect(screen.getByText("128")).toBeDefined()
  })

  it("says nothing was printed only when nothing was", () => {
    const { container } = show("true", "", "success")
    expect(widgetIn(container)).toBe("generic")
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText("No output.")).toBeDefined()
  })
})
