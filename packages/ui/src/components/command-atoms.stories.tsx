import type { Meta, StoryObj } from "@storybook/react-vite"
import { CommandLine } from "./command-line.js"
import { DataGrid } from "./data-grid.js"
import { FailureDetail } from "./failure-detail.js"
import { KeyValueRow } from "./kv-row.js"
import { LogLines } from "./log-lines.js"
import { SegmentedBar } from "./segmented-bar.js"
import { Spinner } from "./loading.js"
import { StatCount } from "./stat-count.js"

/**
 * The atoms the command widgets are assembled from. Each one earns its place by
 * appearing in two or more of the ten widgets — that shared use is what makes a
 * board of ten affordable.
 */
const meta: Meta = { title: "Command Widgets/Atoms" }
export default meta
type Story = StoryObj

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-2">
    <span className="font-mono text-[10px] uppercase tracking-[0.5px] text-dim">{label}</span>
    {children}
  </div>
)

export const Atoms: Story = {
  render: () => (
    <div className="flex w-[560px] flex-col gap-7 bg-editor p-6">
      <Row label="CommandLine — program bright, args dim">
        <div className="flex flex-col gap-1.5 rounded-lg bg-sunken p-3">
          <CommandLine command="vitest run --reporter=verbose" />
          <CommandLine command="pnpm --filter @starbase/ui test" />
          <CommandLine command="./scripts/migrate.sh --dry-run" />
          <CommandLine command="git commit -m 'fix: guard webhook payload'" />
        </div>
      </Row>

      <Row label="StatCount — the test-runner scoreboard">
        <div className="flex items-end gap-6 rounded-lg bg-sunken p-3">
          <StatCount value={128} label="passed" tone="green" />
          <StatCount value={2} label="failed" tone="red" />
          <StatCount value={4} label="skipped" tone="dim" />
        </div>
      </Row>

      <Row label="SegmentedBar — proportional, with the remainder still working">
        <div className="flex flex-col gap-3 rounded-lg bg-sunken p-3">
          <SegmentedBar
            segments={[
              { value: 128, tone: "bg-green" },
              { value: 2, tone: "bg-red" },
              { value: 4, tone: "bg-line" },
              { value: 18, tone: "bg-surface", shine: true }
            ]}
          />
          <SegmentedBar segments={[{ value: 152, tone: "bg-green" }]} />
        </div>
      </Row>

      <Row label="Spinner — 'this row is working' (vs StatusDot's 'this card is live')">
        <div className="flex items-center gap-3 rounded-lg bg-sunken p-3">
          <Spinner tone="working" />
          <Spinner tone="working" size={16} />
          <span className="ml-3 text-[10px] text-dim">default tone, for comparison:</span>
          <Spinner />
        </div>
      </Row>

      <Row label="FailureDetail — a claim, and the evidence under it">
        <FailureDetail title="✗ migrate › applies pending migrations in order">
          expected <span className="text-green">4</span> to equal <span className="text-red">3</span>
          <br />
          <span className="text-dim">at src/db/migrate.test.ts:41:23</span>
        </FailureDetail>
      </Row>

      <Row label="KeyValueRow — dev-server URLs, response headers">
        <div className="flex flex-col gap-1 rounded-lg bg-sunken p-3">
          <KeyValueRow label="Local">
            <a href="#local" className="text-blue">
              http://localhost:5173/
            </a>
          </KeyValueRow>
          <KeyValueRow label="Network">http://192.168.1.24:5173/</KeyValueRow>
          <KeyValueRow label="content-type" labelWidth={170}>
            application/json
          </KeyValueRow>
        </div>
      </Row>

      <Row label="LogLines — tints ✓/✗/warn/error only, never guesses further">
        <div className="rounded-lg bg-sunken p-3">
          <LogLines
            lines={[
              "connecting to postgres…",
              "✓ seeded 8,214 users",
              "✓ seeded 486 teams",
              "warn skipped 3 rows (duplicate key)",
              "done in 2.4s"
            ]}
          />
        </div>
      </Row>

      <Row label="DataGrid — numeric columns right-align and tint">
        <div className="rounded-lg bg-sunken p-3">
          <DataGrid
            columns={[{ key: "plan" }, { key: "count", numeric: true }]}
            rows={[
              ["free", "8,214"],
              ["pro", "1,902"],
              ["team", "486"],
              ["enterprise", "41"]
            ]}
          />
        </div>
      </Row>
    </div>
  )
}
