import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { renderCommandWidget } from "./registry.js"

/**
 * The command widgets — rich renders of a bash tool call, one per command family.
 *
 * Every story goes through the real registry with real captured output, so what
 * you see is the actual classifier and the actual parser, not hand-fed props. If
 * a parser regresses, its story degrades to the generic card and you can see it.
 */
const meta: Meta = { title: "Command Widgets/Overview" }
export default meta
type Story = StoryObj

const Case = ({
  label,
  command,
  output,
  status = "success",
  width = 620
}: {
  label: string
  command: string
  output?: string
  status?: ToolCallStatus
  width?: number
}) => (
  <div className="flex flex-col gap-2.5" style={{ width }}>
    <div className="flex items-center gap-2 text-[12.5px] tracking-[0.3px] text-muted-foreground">
      {label}
    </div>
    {renderCommandWidget({ command, output, status })?.node}
  </div>
)

// ── Captured output, as these tools actually print it ──────────────────────────

const VITEST_DONE = `
 ✓ src/auth/session.test.ts (22 tests) 420ms
 ✓ src/billing/refund.test.ts (18 tests) 1.10s
 ✗ src/db/migrate.test.ts (2 tests | 2 failed) 810ms

 FAIL  src/db/migrate.test.ts > migrate > applies pending migrations in order
AssertionError: expected 4 to equal 3
 ❯ src/db/migrate.test.ts:41:23

 Test Files  1 failed | 2 passed (3)
      Tests  2 failed | 128 passed | 4 skipped (134)
   Duration  3.20s
`

/** Mid-run: the summary block doesn't exist yet, so the scoreboard comes from the file lines. */
const VITEST_RUNNING = `
 ✓ src/auth/session.test.ts (22 tests) 420ms
 ✓ src/billing/refund.test.ts (18 tests) 1.10s
 ❯ src/api/webhook.test.ts
`

const GH_CHECKS = `build\tpass\t1m4s\thttps://github.com/o/r/actions/runs/1
unit\tpass\t48s\thttps://github.com/o/r/actions/runs/2
typecheck\tpass\t31s\thttps://github.com/o/r/actions/runs/3
e2e-playwright\tpending\t2m12s\thttps://github.com/o/r/actions/runs/4
deploy-preview\tqueued\t\thttps://github.com/o/r/actions/runs/5`

const PNPM_INSTALL = `Packages: +12 -3
+++++++++++++---
Progress: resolved 412, reused 400, downloaded 12, added 12, done

dependencies:
+ @tanstack/react-query 5.51.1
+ zod 3.23.8
- jest 29.7.0

devDependencies:
+ vitest 2.0.4

Done in 6.3s`

const PSQL = `    plan    | count
------------+-------
 free       |  8214
 pro        |  12902
 team       |   486
 enterprise |    41
(4 rows)`

const VITE_BUILD = `vite v5.3.1 building for production...
transforming...
✓ 1284 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   1.24 kB │ gzip:   0.61 kB
dist/assets/index-a1b2.css       18.40 kB │ gzip:   4.13 kB
dist/assets/index-c3d4.js       246.80 kB │ gzip:  78.20 kB
dist/assets/vendor-e5f6.js      512.10 kB │ gzip: 168.00 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
✓ built in 4.12s`

const TSC = `src/api/webhook.ts(41,12): error TS18048: 'payload' is possibly 'undefined'.
src/api/webhook.ts(58,3): error TS7030: Not all code paths return a value.
src/billing/refund.ts(22,19): error TS2345: Type 'string' is not assignable to parameter of type 'number'.

Found 3 errors in 2 files.`

const VITE_DEV = `
  VITE v5.3.1  ready in 412 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.24:5173/
  ➜  press h + enter to show help
10:42:18 [vite] page reload src/App.tsx
10:42:31 [vite] hmr update /src/routes/billing.tsx
`

const CURL = `HTTP/2 200
content-type: application/json
x-ratelimit-remaining: 4982

{"id":"cus_9f4a2b8e","matched":true,"confidence":0.94}`

const GIT = `[feat/oauth 3af12e9] fix: guard webhook payload
 3 files changed, 47 insertions(+), 12 deletions(-)
To github.com:trigify/starbase.git
   3af12e9..9d4c1a2  feat/oauth -> feat/oauth`

const SEED = `connecting to postgres…
✓ seeded 8,214 users
✓ seeded 486 teams
warn skipped 3 rows (duplicate key)
done in 2.4s`

// ── Stories ───────────────────────────────────────────────────────────────────

/** The whole board, mirroring the design doc. */
export const Board: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-x-12 gap-y-11 bg-canvas p-10">
      <Case label="W1 · Test runner — finished, with a failure" command="vitest run" output={VITEST_DONE} status="error" />
      <Case label="W2 · CI / PR checks" command="gh pr checks 482 --watch" output={GH_CHECKS} status="running" width={520} />
      <Case label="W3 · Package install" command="pnpm install" output={PNPM_INSTALL} width={480} />
      <Case label="W4 · Database query" command={`psql $DATABASE_URL -c "select plan, count(*) from users where active group by plan order by 2 desc;"`} output={PSQL} width={480} />
      <Case label="W5 · Build output" command="pnpm build" output={VITE_BUILD} width={520} />
      <Case label="W6 · Lint / typecheck" command="tsc --noEmit" output={TSC} status="error" width={520} />
      <Case label="W7 · Dev server" command="pnpm dev" output={VITE_DEV} status="running" width={480} />
      <Case label="W8 · HTTP request" command="curl -s -i -X POST https://api.trigify.io/v1/enrich" output={CURL} width={480} />
      <Case label="W9 · Git operation" command="git commit -m 'fix: guard webhook payload' && git push" output={GIT} width={480} />
      <Case label="W10 · Generic command" command="./scripts/seed.sh" output={SEED} width={480} />
    </div>
  )
}

export const TestRunner: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case label="Finished — 2 failed" command="vitest run" output={VITEST_DONE} status="error" />
      <Case label="Watch mode" command="vitest --watch" output={VITEST_DONE} status="error" />
      <Case
        label="Mid-run — scoreboard built from streamed file lines, before any summary exists"
        command="vitest run"
        output={VITEST_RUNNING}
        status="running"
      />
      <Case
        label="Declines: a shell error is not a test report, so the generic card takes it"
        command="pnpm test"
        output="bash: vitest: command not found"
        status="error"
      />
    </div>
  )
}

export const CiChecks: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case label="Running" command="gh pr checks 482 --watch" output={GH_CHECKS} status="running" width={520} />
      <Case
        label="All green"
        command="gh pr checks"
        output={GH_CHECKS.replace(/pending|queued/g, "pass")}
        width={520}
      />
    </div>
  )
}

export const BuildAndDiagnostics: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case label="W5 · Build with a chunk-size warning" command="pnpm build" output={VITE_BUILD} width={520} />
      <Case label="W6 · tsc — grouped by file" command="tsc --noEmit" output={TSC} status="error" width={520} />
      <Case
        label="W6 · eslint stylish"
        command="pnpm lint"
        status="error"
        width={520}
        output={`/repo/src/api/webhook.ts
  41:12  error    'payload' is possibly undefined  no-unsafe-optional-chaining
  58:3   warning  Missing return type              @typescript-eslint/explicit-function-return-type

✖ 2 problems (1 error, 1 warning)`}
      />
    </div>
  )
}

export const DevServer: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case label="Listening" command="pnpm dev" output={VITE_DEV} status="running" width={480} />
      <Case
        label="Next.js"
        command="next dev"
        status="running"
        width={480}
        output={`  ▲ Next.js 14.2.3
  - Local:        http://localhost:3000
  - Network:      http://192.168.1.24:3000
 ✓ Ready in 2.1s`}
      />
      <Case
        label="No output yet — a long-running server prints nothing until it exits, so this
              correctly falls back to the plain card until ToolDelta streaming lands"
        command="pnpm dev"
        output={undefined}
        status="running"
        width={480}
      />
    </div>
  )
}

export const DataAndNetwork: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case
        label="W4 · psql with inline SQL"
        command={`psql $DATABASE_URL -c "select plan, count(*) from users where active group by plan order by 2 desc;"`}
        output={PSQL}
        width={480}
      />
      <Case label="W8 · curl with headers (-i)" command="curl -s -i -X POST https://api.trigify.io/v1/enrich" output={CURL} width={480} />
      <Case
        label="W8 · curl without headers — the common case: no pill, just the body"
        command="curl -s https://api.trigify.io/v1/me"
        output={`{"id":"usr_1","email":"morgan@trigify.io","plan":"team"}`}
        width={480}
      />
      <Case
        label="W8 · a non-JSON body falls back to raw lines rather than a half-highlighted mess"
        command="curl -s https://example.com/health"
        output="OK"
        width={480}
      />
    </div>
  )
}

export const GitAndInstall: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case label="W9 · commit && push" command="git commit -m 'fix: guard webhook payload' && git push" output={GIT} width={480} />
      <Case label="W3 · pnpm install" command="pnpm install" output={PNPM_INSTALL} width={480} />
      <Case
        label="W3 · npm, which prints no per-package list — counts only, no invented rows"
        command="npm install"
        output="added 12 packages, removed 3 packages, and audited 412 packages in 6s"
        width={480}
      />
    </div>
  )
}

export const Generic: Story = {
  render: () => (
    <div className="flex flex-col gap-9 bg-editor p-8">
      <Case label="Collapsed by default — click to expand" command="./scripts/migrate.sh --dry-run" output={SEED} width={480} />
      <Case label="Failed" command="./scripts/deploy.sh" output={"connecting…\nerror: missing credentials"} status="error" width={480} />
      <Case label="Printed nothing" command="true" output="" width={480} />
      <Case
        label="Middle elided by the output cap — said, not hidden"
        command="./scripts/noisy.sh"
        output={`line 1\nline 2\n\n… 4,096 characters omitted …\n\nline 998\nline 999`}
        width={480}
      />
    </div>
  )
}
