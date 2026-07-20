import type { PlanChallenge, PlanStep } from "@starbase/core"
import { unresolvedChallenges, wasChallenged } from "@starbase/core"
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * What a rival lab said about a plan step, and what the proposer did about it.
 *
 * Three display rules carry the whole point of the feature:
 *
 *  1. **Unresolved reads loudest.** A challenge the revision never engaged with
 *     is where the two models still disagree, which is exactly where a human
 *     should look. It is the only state rendered in a warning tone.
 *  2. **Defended is not resolved-quietly.** The proposer considered it and kept
 *     its approach, and its reason is shown *with* the objection so the reader
 *     can judge the disagreement rather than take the model's word for it.
 *  3. **"Nobody looked" never renders as "nothing wrong."** An absent
 *     `challenges` array means no adversary examined this step; an empty one
 *     means it was examined and survived. Collapsing those would let an
 *     unreviewed plan wear a clean bill of health.
 */

const SEVERITY_TONE: Record<PlanChallenge["severity"], string> = {
  critical: "text-red",
  major: "text-orange",
  minor: "text-yellow",
  nit: "text-muted-foreground"
}

const STATUS_LABEL: Record<PlanChallenge["status"], string> = {
  open: "unresolved",
  addressed: "addressed",
  defended: "defended"
}

/**
 * A one-glance badge for a step row: how many objections are still open, or that
 * the step was examined and survived. Renders nothing when no adversary ran.
 */
export function ChallengeBadge({ step, className }: { step: PlanStep; className?: string }) {
  if (!wasChallenged(step)) return null
  const open = unresolvedChallenges(step).length
  if (open > 0) {
    return (
      <span
        className={cn("flex flex-none items-center gap-1 font-mono text-[9.5px] text-orange", className)}
        title={`${open} challenge${open === 1 ? "" : "s"} the revision did not address`}
      >
        <ShieldAlert className="size-3" />
        {open}
      </span>
    )
  }
  return (
    <ShieldCheck
      className={cn("size-3 flex-none text-green/70", className)}
      // Deliberately says "examined", not "approved" — the critic found nothing,
      // which is a weaker claim than an endorsement.
      aria-label="Examined by a rival model; nothing raised"
    />
  )
}

/** The full challenge list for one step, shown in the step's detail pane. */
export function PlanChallenges({ step, className }: { step: PlanStep; className?: string }) {
  if (!wasChallenged(step)) {
    return (
      <div
        className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", className)}
      >
        <ShieldQuestion className="size-3.5 flex-none" />
        No rival model reviewed this step.
      </div>
    )
  }

  const challenges = step.challenges ?? []
  if (challenges.length === 0) {
    return (
      <div className={cn("flex items-center gap-1.5 text-[11px] text-green/80", className)}>
        <ShieldCheck className="size-3.5 flex-none" />
        A rival model reviewed this step and raised nothing.
      </div>
    )
  }

  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {challenges.map((c) => (
        <li
          key={c.id}
          className={cn(
            "rounded-md border px-2.5 py-2",
            c.status === "open" ? "border-orange/40 bg-orange/5" : "border-border bg-surface"
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cn("font-mono text-[9.5px] uppercase tracking-wide", SEVERITY_TONE[c.severity])}>
              {c.severity}
            </span>
            <span
              className={cn(
                "rounded-sm px-1 font-mono text-[9px] uppercase tracking-wide",
                c.status === "open"
                  ? "bg-orange/15 text-orange"
                  : c.status === "defended"
                    ? "bg-purple/15 text-purple"
                    : "bg-green/15 text-green"
              )}
            >
              {STATUS_LABEL[c.status]}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-text">{c.title}</p>
          {c.rationale && <p className="mt-0.5 text-[11.5px] text-text-body">{c.rationale}</p>}
          {c.status === "defended" && c.defence && (
            <p className="mt-1.5 border-l-2 border-purple/40 pl-2 text-[11.5px] text-text-body">
              <span className="font-mono text-[9.5px] uppercase tracking-wide text-purple">
                kept anyway —{" "}
              </span>
              {c.defence}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Who proposed the step and who should build it.
 *
 * The assignee's reason is always the model's own words. A chip that invented
 * its own justification would be lying about where the recommendation came from,
 * and the evidence line says which level of the knowledge base answered so a
 * cold-start guess never reads like a measured result.
 */
export function PlanProvenance({ step, className }: { step: PlanStep; className?: string }) {
  const { origin, assignee, taskKind } = step
  if (!origin && !assignee && !taskKind) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]", className)}>
      {origin && (
        <span className="text-muted-foreground">
          proposed by <span className="text-text-body">{origin.model}</span>{" "}
          <span className="text-muted-foreground/70">({origin.vendor})</span>
        </span>
      )}
      {taskKind && (
        <span className="rounded-sm bg-surface px-1 font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground">
          {taskKind}
        </span>
      )}
      {assignee && (
        <span className="text-muted-foreground">
          build with{" "}
          <span className="text-text-body">
            {assignee.cli} {assignee.model}
          </span>
          {assignee.reason && <span className="text-muted-foreground"> — {assignee.reason}</span>}
          {assignee.evidence && (
            <span className="ml-1 font-mono text-[9.5px] text-muted-foreground/70">
              [{assignee.evidence.level}, n={assignee.evidence.observations}]
            </span>
          )}
        </span>
      )}
    </div>
  )
}
