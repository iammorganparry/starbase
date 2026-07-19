import type { CliKind, HarnessBilling, ProviderModels } from "@starbase/core"
import { cn } from "../lib/cn.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/select.js"

/**
 * What Gigaplan itself runs on.
 *
 * ONE model, not a per-message choice. Gigaplan's claim is that it picks the
 * right agent for a piece of work, but that is only interesting where the answer
 * varies — across the steps of a plan. For its own voice, an operator wants a
 * competent assistant with a predictable identity, not a router that silently
 * changes who they are talking to between messages.
 *
 * Separate from the per-provider cards on purpose: those set what a NEW session
 * starts with, and are answered per harness. This is one global choice about the
 * orchestrator, and putting it in a provider card would imply it varies by
 * harness when it is exactly the thing that does not.
 */

export interface GigaplanSettingsProps {
  /** Every installed harness and its models — the same catalogue the composer uses. */
  readonly catalog: ReadonlyArray<ProviderModels>
  /** The configured orchestrator, or null to show the default. */
  readonly orchestrator: { readonly cli: CliKind; readonly model: string } | null
  /** What it falls back to when unset — stated, never left implicit. */
  readonly defaultOrchestrator: { readonly cli: CliKind; readonly model: string }
  readonly onChange: (cli: CliKind, model: string) => void
  /** Why Gigaplan can't run here, when it can't. Null when it can. */
  readonly unavailableReason?: string | null
  /** What each installed harness is charged to. Empty until the probe returns. */
  readonly billing?: ReadonlyArray<HarnessBilling>
  readonly className?: string
}

/** `<cli>:<model>` — ids aren't unique across harnesses, so the pair is the value. */
const valueOf = (cli: CliKind, model: string) => `${cli}:${model}`

export function GigaplanSettings({
  catalog,
  orchestrator,
  defaultOrchestrator,
  onChange,
  unavailableReason,
  billing = [],
  className
}: GigaplanSettingsProps) {
  const active = orchestrator ?? defaultOrchestrator
  // `starbase` is filtered for the same reason it is filtered from the composer's
  // picker: the orchestrator cannot be its own backend.
  const groups = catalog.filter((p) => p.cli !== "starbase" && p.models.length > 0)

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <section className="flex flex-col gap-1">
        <span className="text-[15px] font-bold text-text-bright">Gigaplan</span>
        <span className="text-[11.5px] leading-relaxed text-muted-foreground">
          One flagship proposes a plan, a model from a rival lab attacks it, and the proposer
          revises. On approval each step runs on the harness the plan chose for it.
        </span>
      </section>

      {unavailableReason ? (
        // Stated rather than hidden: an operator who cannot use the mode should
        // learn what to install, not find the setting missing.
        <p className="rounded-md border border-yellow/40 bg-yellow/5 px-3 py-2 text-[11.5px] text-yellow">
          {unavailableReason}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold text-text">Orchestrator model</span>
        <span className="text-[11.5px] leading-relaxed text-muted-foreground">
          What Gigaplan speaks as — its planning, and anything you ask it directly. Model choice
          for the plan&rsquo;s individual steps is made per step and is not set here.
        </span>
        <Select
          value={valueOf(active.cli, active.model)}
          onValueChange={(v) => {
            const at = v.indexOf(":")
            if (at < 0) return
            onChange(v.slice(0, at) as CliKind, v.slice(at + 1))
          }}
        >
          <SelectTrigger className="w-[280px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((p) =>
              p.models.map((m) => (
                <SelectItem key={valueOf(p.cli, m.id)} value={valueOf(p.cli, m.id)}>
                  {p.label} · {m.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        {orchestrator === null ? (
          <span className="text-[11px] text-muted-foreground">
            Using the default ({defaultOrchestrator.cli} · {defaultOrchestrator.model}). A flagship
            on purpose: this model plans, and reads whole repositories to do it.
          </span>
        ) : null}
      </div>

      {billing.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-semibold text-text">What this is charged to</span>
          <span className="text-[11.5px] leading-relaxed text-muted-foreground">
            Starbase drives the harnesses you already pay for. Where a plan is available its
            metered key is withheld, so an API key left in your shell can&rsquo;t silently take
            over the billing.
          </span>
          <ul className="flex list-none flex-col gap-1 p-0">
            {billing.map((b) => (
              <li key={b.cli} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-[86px] font-mono text-[11px] text-text">{b.cli}</span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-[0.3px]",
                    b.path === "subscription"
                      ? "border-green/40 text-green"
                      : b.path === "api-key"
                        ? "border-yellow/40 text-yellow"
                        : "border-line text-muted-foreground"
                  )}
                >
                  {b.path === "subscription"
                    ? "your plan"
                    : b.path === "api-key"
                      ? "API key — metered"
                      : "not signed in"}
                </span>
                {/* Named explicitly: this is the case that used to cost money
                    without anyone noticing. */}
                {b.keyWithheld ? (
                  <span className="text-[11px] text-muted-foreground">
                    an API key in your environment was ignored in favour of the plan
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
