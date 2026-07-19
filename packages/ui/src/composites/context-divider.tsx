import { useState } from "react"
import { ChevronRight, Layers } from "lucide-react"
import type { ContextDigest } from "@starbase/core"
import { cn } from "../lib/cn.js"

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)

const Section = ({
  title,
  items
}: {
  title: string
  items: ReadonlyArray<string>
}) =>
  items.length === 0 ? null : (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-dim">{title}</div>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="text-xs leading-relaxed text-muted-foreground">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )

/**
 * The in-transcript record of a compaction.
 *
 * The transcript above and below this marker is complete — nothing was deleted.
 * What changed is what the MODEL is still holding, and this is the only place a
 * user can check that. Without it the context meter simply drops between turns
 * with no explanation, which is how `/compact` behaves and precisely why it
 * feels like the app threw your work away.
 *
 * Collapsed by default: this is reassurance, not content. It should be findable
 * when someone wonders "does it still know about X", and invisible otherwise.
 */
export function ContextDivider({
  digest,
  tokensBefore,
  className
}: {
  digest: ContextDigest
  /** Working set immediately before the reseed, for the "290k → summary" line. */
  tokensBefore: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const kept =
    digest.decisions.length + digest.filesTouched.length + digest.openThreads.length +
    digest.preferences.length

  return (
    <div className={cn("my-3", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-left"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-bg px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors group-hover:text-fg">
          <Layers className="size-3 text-dim" />
          Context compacted
          {tokensBefore > 0 && <span className="text-dim">from {fmtTokens(tokensBefore)}</span>}
          <ChevronRight
            className={cn("size-3 text-dim transition-transform", open && "rotate-90")}
          />
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-md border border-border bg-fg/[0.02] p-3">
          <p className="text-[11px] leading-relaxed text-dim">
            Your full history above is unchanged. This is what the agent carried
            forward into a fresh conversation — {kept} item{kept === 1 ? "" : "s"} kept.
          </p>
          <Section title="Goal" items={[digest.goal]} />
          <Section title="Decisions" items={digest.decisions} />
          <Section title="Files touched" items={digest.filesTouched} />
          <Section title="Open threads" items={digest.openThreads} />
          <Section title="Your preferences" items={digest.preferences} />
        </div>
      )}
    </div>
  )
}
