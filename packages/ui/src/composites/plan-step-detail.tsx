import { useState } from "react"
import type { Plan, PlanFileChange, PlanGuard, PlanStep } from "@starbase/core"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  Circle,
  CircleAlert,
  CircleDot,
  Loader
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { PlanChallenges, PlanProvenance } from "./plan-challenges.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"
import { Markdown } from "../components/markdown.js"
import { PlanFlow } from "./plan-flow.js"

const CHANGE_TONE: Record<PlanFileChange["change"], "green" | "yellow" | "red"> = {
  A: "green",
  M: "yellow",
  D: "red"
}
const CHANGE_LABEL: Record<PlanFileChange["change"], string> = { A: "A", M: "M", D: "D" }

function GuardIcon({ status }: { status: PlanGuard["status"] }) {
  if (status === "ok") return <Check className="size-3.5 flex-none text-green" />
  if (status === "warn") return <CircleAlert className="size-3.5 flex-none text-yellow" />
  if (status === "under-review") return <Loader className="size-3.5 flex-none animate-spin text-cyan" />
  return <Circle className="size-3.5 flex-none text-muted-foreground" />
}

const numberOf = (plan: Plan, id: string | null): string | null =>
  plan.steps.find((s) => s.id === id)?.number ?? null

/**
 * One plan step's full spec (design screen 05): breadcrumb + meta, intent,
 * numbered approach, proposed file changes, an acceptance checklist, and a
 * per-step discussion thread with a "route to the agent" composer. Prev/next
 * walk the plan in order.
 */
export function PlanStepDetail({
  plan,
  step,
  onBack,
  onSelect,
  onComment,
  className
}: {
  plan: Plan
  step: PlanStep
  /** Return to the flow view. */
  onBack?: () => void
  onSelect?: (stepId: string) => void
  onComment?: (stepId: string, body: string) => void
  className?: string
}) {
  const [draft, setDraft] = useState("")
  const comments = plan.comments.filter((c) => c.stepId === step.id)
  const idx = plan.steps.findIndex((s) => s.id === step.id)
  const prev = idx > 0 ? plan.steps[idx - 1]! : null
  const next = idx < plan.steps.length - 1 ? plan.steps[idx + 1]! : null
  const parentNumber = step.kind === "branch-arm" ? numberOf(plan, step.parentId) : null
  const readOnly = plan.status === "approved" || plan.status === "rejected" || plan.status === "stale"

  const submit = () => {
    const body = draft.trim()
    if (!body) return
    onComment?.(step.id, body)
    setDraft("")
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-editor", className)}>
      {/* Breadcrumb */}
      <div className="flex flex-none items-center gap-1.5 border-b border-hairline px-4 py-2.5 text-[11.5px]">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mr-1 flex items-center gap-1 text-muted-foreground transition-colors hover:text-text active:scale-[0.97]"
          >
            <ChevronLeft className="size-3.5" /> Back to flow
          </button>
        )}
        <span className="text-muted-foreground">Plan</span>
        <span className="text-line-strong">›</span>
        {parentNumber && (
          <>
            <span className="text-muted-foreground">{parentNumber}</span>
            <span className="text-line-strong">›</span>
          </>
        )}
        <span className="font-semibold text-text">
          {step.number} {step.title}
        </span>
        {step.flagged && (
          <Badge tone="yellow" size="xs" className="ml-1">
            {plan.status === "revising" ? "agent revising" : "flagged"}
          </Badge>
        )}
        {step.changed && (
          <Badge tone="green" size="xs" className="ml-1">
            updated
          </Badge>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
        {/* Meta chips */}
        <div className="flex flex-wrap items-center gap-2">
          {step.kind === "branch" && <Badge tone="purple" size="xs">branch</Badge>}
          {step.dependsOn.map((d) => (
            <Badge key={`dep-${d}`} tone="neutral" size="xs">
              depends {d}
            </Badge>
          ))}
          {step.blocks.map((b) => (
            <Badge key={`blk-${b}`} tone="neutral" size="xs">
              blocks {b}
            </Badge>
          ))}
          {step.diff && <DiffStat added={step.diff.added} removed={step.diff.removed} />}
        </div>

        {(step.origin || step.assignee || step.taskKind || step.routing) && (
          <Section title="Routing">
            <PlanProvenance step={step} />
          </Section>
        )}

        {step.intent && (
          <Section title="Intent">
            <p className="m-0 text-[13px] leading-[1.6] text-text-body">{step.intent}</p>
          </Section>
        )}

        {/*
          The agent skipped the ```plan fence (even after being asked to reformat),
          so there are no steps to review — show what it actually wrote. Without
          this the plan's entire content is invisible.
        */}
        {!plan.structured && plan.raw && (
          <Section title="Plan">
            <Markdown>{plan.raw}</Markdown>
          </Section>
        )}

        {step.approach.length > 0 && (
          <Section title="Approach">
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
              {step.approach.map((a, i) => (
                <li key={i} className="flex gap-2.5 text-[12.5px] leading-[1.55] text-text-body">
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{i + 1}</span>
                  <span>{a}</span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        {step.graph && (
          <Section title="Control flow">
            {/* Flex column so PlanFlow's `flex-1` react-flow host resolves to a
                real height — without it the canvas collapses to 0 and the box
                paints empty. */}
            <div className="flex h-[300px] flex-col overflow-hidden rounded-md border border-hairline bg-editor">
              {/* `onSelect` was missing here, so nodes linking to another step were
                  dead clicks — the canvas has always supported the jump. */}
              <PlanFlow graph={step.graph} selectedId={step.id} onSelect={onSelect} embedded />
            </div>
          </Section>
        )}

        {step.files.length > 0 && (
          <Section title="Files & proposed change">
            <div className="flex flex-col gap-1.5">
              {step.files.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center gap-2.5 rounded-md border border-hairline bg-panel px-2.5 py-1.5"
                >
                  <Badge tone={CHANGE_TONE[f.change]} size="xs">
                    {CHANGE_LABEL[f.change]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-body">{f.path}</span>
                  <DiffStat added={f.added} removed={f.removed} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {step.code && (
          <Section title="Proposed code">
            <div className="overflow-hidden rounded-md border border-hairline bg-panel">
              <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5">
                <span className="text-[10.5px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
                  Illustrative — the shape of the change
                </span>
                {step.code.lang && (
                  <Badge tone="neutral" size="xs">
                    {step.code.lang}
                  </Badge>
                )}
              </div>
              <div className="[&_pre]:!m-0 [&_pre]:!rounded-none [&_pre]:!border-0 overflow-x-auto text-[12px]">
                <Markdown>{`\`\`\`${step.code.lang ?? ""}\n${step.code.body}\n\`\`\``}</Markdown>
              </div>
            </div>
          </Section>
        )}

        {step.challenges !== undefined && (
          <Section title="Adversarial review">
            <PlanChallenges step={step} />
          </Section>
        )}

        {step.guards.length > 0 && (
          <Section title="Guards & acceptance">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {step.guards.map((g, i) => (
                <li key={i} className="flex items-center gap-2 text-[12.5px] text-text-body">
                  <GuardIcon status={g.status} />
                  <span className={cn(g.status === "under-review" && "text-cyan")}>{g.text}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Discussion */}
        <Section title={`Discussion${comments.length ? ` · ${comments.length}` : ""}`}>
          {comments.length === 0 ? (
            <p className="m-0 text-[12px] text-muted-foreground">No comments on this step yet.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {comments.map((c) => (
                <div key={c.id} className="flex flex-col gap-1 rounded-md border border-hairline bg-panel px-3 py-2">
                  <span className="flex items-center gap-2 text-[10.5px]">
                    <span className={cn("font-semibold", c.author === "agent" ? "text-blue" : "text-text")}>
                      {c.author === "agent" ? "Claude" : "You"}
                    </span>
                    {c.routed && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <CircleDot className="size-2.5" /> routed to agent
                      </span>
                    )}
                  </span>
                  <p className="m-0 text-[12.5px] leading-[1.5] text-text-body">{c.body}</p>
                </div>
              ))}
            </div>
          )}

          {!readOnly && (
            <div className="mt-2.5 flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
                }}
                rows={2}
                placeholder="Scrutinise this step…"
                className="w-full resize-none rounded-md border border-line bg-panel px-3 py-2 text-[12.5px] text-text-body placeholder:text-muted-foreground focus:border-blue/50 focus:outline-none"
              />
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" onClick={submit} disabled={draft.trim().length === 0}>
                  Comment on step
                </Button>
              </div>
            </div>
          )}
        </Section>
      </div>

      {/* Prev / next nav */}
      <div className="flex flex-none items-center justify-between border-t border-hairline px-4 py-2 text-[11.5px]">
        <button
          type="button"
          disabled={!prev}
          onClick={() => prev && onSelect?.(prev.id)}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-text disabled:opacity-40 active:scale-[0.97]"
        >
          <ArrowLeft className="size-3.5" />
          {prev ? `${prev.number} ${prev.title}` : "Start"}
        </button>
        <span className="font-mono text-[10px] text-muted-foreground">
          step {step.number} of {plan.steps.filter((s) => s.kind !== "branch-arm").length}
        </span>
        <button
          type="button"
          disabled={!next}
          onClick={() => next && onSelect?.(next.id)}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-text disabled:opacity-40 active:scale-[0.97]"
        >
          {next ? `${next.number} ${next.title}` : "End"}
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}
