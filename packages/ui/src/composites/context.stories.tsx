import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ContextDigest } from "@starbase/core"
import { ContextDivider } from "./context-divider.js"
import { ContextMeter } from "./context-meter.js"

const meta: Meta = { title: "Molecules/Context" }
export default meta
type Story = StoryObj

const digest: ContextDigest = {
  goal: "Add rate limiting to the refund route and cover it with a 429 test",
  decisions: [
    "Reused the token bucket in lib/ratelimit.ts rather than adding a dependency",
    "Limited per-account, not per-IP, so shared offices aren't punished"
  ],
  filesTouched: ["src/routes/billing.ts", "src/routes/billing.test.ts"],
  openThreads: ["The 429 test still fails intermittently under load"],
  preferences: ["Prefers Effect over raw async", "Wants tests alongside the change, not after"],
  throughMessageId: "m42",
  builtAt: "2026-07-19T12:00:00.000Z"
}

/**
 * The meter fills toward the COMPACTION TRIGGER, never the model's hard ceiling.
 * The 1M row is the one that matters: at 300k it reads full, because 300k is
 * where quality starts to go — a bar sitting at 30% there would be telling the
 * user the opposite of what they need to know.
 */
export const Meter: Story = {
  render: () => (
    <div className="w-[420px] space-y-3 p-6">
      {[
        { label: "Early in a 200k session", tokens: 30_000, triggerAt: 170_000 },
        { label: "Half way", tokens: 85_000, triggerAt: 170_000 },
        { label: "Approaching the trigger", tokens: 150_000, triggerAt: 170_000 },
        { label: "Over — a digest is being prepared", tokens: 178_000, triggerAt: 170_000 },
        { label: "Digest ready, reseeds next turn", tokens: 178_000, triggerAt: 170_000, ready: true },
        { label: "1M model at 300k — full, not 30%", tokens: 300_000, triggerAt: 300_000 }
      ].map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4">
          <span className="text-[11px] text-muted-foreground">{row.label}</span>
          <ContextMeter tokens={row.tokens} triggerAt={row.triggerAt} digestReady={row.ready} />
        </div>
      ))}
      <div className="flex items-center justify-between gap-4">
        <span className="text-[11px] text-muted-foreground">
          Harness reports no usage — renders nothing
        </span>
        <ContextMeter tokens={120_000} triggerAt={null} />
      </div>
    </div>
  )
}

/** Collapsed by default — findable when someone wonders, invisible otherwise. */
export const Divider: Story = {
  render: () => (
    <div className="w-[760px] p-6">
      <p className="mb-2 text-[13px] text-muted-foreground">…earlier conversation…</p>
      <ContextDivider digest={digest} tokensBefore={290_000} />
      <p className="mt-2 text-[13px] text-muted-foreground">…the turn that ran on the fresh context…</p>
    </div>
  )
}
