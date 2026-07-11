import type { Meta, StoryObj } from "@storybook/react-vite"
import { DiffView } from "./diff-view.js"
import type { DiffRow } from "./parse.js"
import { SEED_PATCH } from "../seed.js"

const meta: Meta<typeof DiffView> = {
  title: "Diff/DiffView",
  component: DiffView,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof DiffView>

export const FromPatch: Story = {
  render: () => (
    <div className="h-[500px] w-[560px] overflow-hidden rounded-lg border border-line">
      <DiffView patch={SEED_PATCH} />
    </div>
  )
}

/** Verifies virtualization: 200 files × ~50 lines ≈ 10,000 rows render instantly. */
export const HugeDiff: Story = {
  render: () => {
    const rows: DiffRow[] = []
    for (let f = 0; f < 200; f++) {
      rows.push({
        kind: "file",
        key: `f${f}`,
        path: `src/generated/module-${f}.ts`,
        status: "modified",
        additions: 25,
        deletions: 12
      })
      rows.push({ kind: "hunk", key: `f${f}h`, header: `@@ -1,50 +1,50 @@ module ${f}` })
      for (let l = 0; l < 48; l++) {
        const type = l % 4 === 0 ? "del" : l % 3 === 0 ? "add" : "normal"
        rows.push({
          kind: "line",
          key: `f${f}l${l}`,
          type,
          oldLn: type === "add" ? null : l + 1,
          newLn: type === "del" ? null : l + 1,
          content: `  const value_${f}_${l} = compute(${l}) // ${type}`
        })
      }
    }
    return (
      <div className="flex h-screen w-full flex-col">
        <div className="flex-none border-b border-line bg-panel px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {rows.length.toLocaleString()} virtualized rows — scroll freely
        </div>
        <div className="min-h-0 flex-1">
          <DiffView rows={rows} />
        </div>
      </div>
    )
  }
}
