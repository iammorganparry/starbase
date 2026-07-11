import { GitMerge, Hammer, ScanSearch, GitPullRequest } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { TabKey } from "../app/tab-bar.js"

const META: Partial<Record<TabKey, { title: string; blurb: string; icon: LucideIcon }>> = {
  pr: { title: "Pull Request", blurb: "CI status, review timeline and the agent feedback loop.", icon: GitPullRequest },
  review: { title: "Code Review", blurb: "Select lines, comment, and route changes back to the agent.", icon: ScanSearch },
  plan: { title: "Plan Review", blurb: "Visualise the plan, step through flow control, annotate and gate steps.", icon: GitMerge },
  workflow: {
    title: "Workflow",
    blurb: "Deterministic multi-agent runs — Build → Review → Reconcile across worktrees.",
    icon: Hammer
  }
}

/** Placeholder for screens not built in this milestone. */
export function StubScreen({ tab }: { tab: TabKey }) {
  const meta = META[tab]
  const Icon = meta?.icon ?? Hammer
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5 bg-editor text-dim">
      <Icon size={40} className="text-line" strokeWidth={1.5} />
      <div className="text-[16px] font-semibold text-text">{meta?.title ?? "Coming soon"}</div>
      <div className="max-w-[360px] text-center text-[13px] leading-[1.6]">{meta?.blurb}</div>
      <div className="font-mono text-[11px] text-line">Next milestone</div>
    </div>
  )
}
