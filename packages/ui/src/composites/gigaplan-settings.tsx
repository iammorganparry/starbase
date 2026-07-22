import type {
  CliKind,
  GigaplanRouteConfigCandidate,
  GigaplanRoutingConfig,
  HarnessBilling,
  ProviderModels,
  TaskKind
} from "@starbase/core"
import { GIGAPLAN_ROUTING_DEFAULT, TASK_KINDS } from "@starbase/core"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "../components/button.js"
import { SegmentedControl } from "../components/segmented-control.js"
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
  /** Semantic step policy; absence is the legacy-safe shadow default. */
  readonly routing?: GigaplanRoutingConfig | null
  readonly onRoutingChange?: (routing: GigaplanRoutingConfig) => void
  /** Why Gigaplan can't run here, when it can't. Null when it can. */
  readonly unavailableReason?: string | null
  /** What each installed harness is charged to. Empty until the probe returns. */
  readonly billing?: ReadonlyArray<HarnessBilling>
  readonly className?: string
}

/** `<cli>:<model>` — ids aren't unique across harnesses, so the pair is the value. */
const harnessModelValue = (cli: CliKind, model: string) => `${cli}:${model}`

export function GigaplanSettings({
  catalog,
  orchestrator,
  defaultOrchestrator,
  onChange,
  routing,
  onRoutingChange,
  unavailableReason,
  billing = [],
  className
}: GigaplanSettingsProps) {
  const active = orchestrator ?? defaultOrchestrator
  const routeConfig = routing ?? GIGAPLAN_ROUTING_DEFAULT
  // `starbase` is filtered for the same reason it is filtered from the composer's
  // picker: the orchestrator cannot be its own backend.
  const groups = catalog.filter((p) => p.cli !== "starbase" && p.models.length > 0)
  const liveRoutes: ReadonlyArray<GigaplanRouteConfigCandidate> = groups.flatMap((provider) =>
    provider.models.map((model) => ({ cli: provider.cli, model: model.id }))
  )
  const updateRoutes = (taskKind: TaskKind, routes: ReadonlyArray<GigaplanRouteConfigCandidate>) => {
    if (onRoutingChange === undefined) return
    const rest = routeConfig.overrides.filter((override) => override.taskKind !== taskKind)
    onRoutingChange({
      ...routeConfig,
      overrides: routes.length === 0 ? rest : [...rest, { taskKind, routes }]
    })
  }

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
          value={harnessModelValue(active.cli, active.model)}
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
                <SelectItem key={harnessModelValue(p.cli, m.id)} value={harnessModelValue(p.cli, m.id)}>
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

      <div className="flex flex-col gap-3 border-t border-hairline pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="block text-[12px] font-semibold text-text">Step routing policy</span>
            <span className="text-[11.5px] leading-relaxed text-muted-foreground">
              Shadow records semantic recommendations without changing execution. Active applies
              eligible overrides, OpenRouter&apos;s rolling task-usage rankings, and deterministic
              task profiles. Usage rankings only reorder models available on this machine.
            </span>
          </div>
          <SegmentedControl
            items={[
              { value: "shadow", label: "Shadow" },
              { value: "active", label: "Active" }
            ]}
            value={routeConfig.mode}
            onChange={(mode) => onRoutingChange?.({ ...routeConfig, mode })}
          />
        </div>

        <details className="rounded-lg border border-line bg-panel p-3">
          <summary className="cursor-pointer text-[11.5px] font-semibold text-text">
            Advanced task-kind overrides
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {TASK_KINDS.map((taskKind) => {
              const routes =
                routeConfig.overrides.find((override) => override.taskKind === taskKind)?.routes ?? []
              return (
                <div key={taskKind} className="grid gap-2 border-t border-hairline pt-3 first:border-0 first:pt-0">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    {taskKind}
                  </span>
                  {routes.map((route, index) => {
                    const isLive = liveRoutes.some(
                      (candidate) => candidate.cli === route.cli && candidate.model === route.model
                    )
                    const options = isLive ? liveRoutes : [route, ...liveRoutes]
                    return (
                      <div key={`${route.cli}:${route.model}:${index}`} className="flex items-center gap-2">
                        <span className="w-5 font-mono text-[10px] text-dim">{index + 1}</span>
                        <Select
                          value={harnessModelValue(route.cli, route.model)}
                          onValueChange={(value) => {
                            const candidate = options.find(
                              (option) => harnessModelValue(option.cli, option.model) === value
                            )
                            if (candidate === undefined) return
                            const next = [...routes]
                            next[index] = candidate
                            updateRoutes(taskKind, next)
                          }}
                        >
                          <SelectTrigger
                            aria-label={`${taskKind} route ${index + 1}`}
                            className="min-w-0 flex-1"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {options.map((candidate) => (
                              <SelectItem
                                key={harnessModelValue(candidate.cli, candidate.model)}
                                value={harnessModelValue(candidate.cli, candidate.model)}
                              >
                                {candidate.cli} · {candidate.model}
                                {!liveRoutes.some(
                                  (live) =>
                                    live.cli === candidate.cli && live.model === candidate.model
                                )
                                  ? " (unavailable)"
                                  : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {!isLive && (
                          <span className="text-[10px] text-yellow">
                            {route.cli}/{route.model} unavailable
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${taskKind} route ${index + 1}`}
                          onClick={() => updateRoutes(taskKind, routes.filter((_, i) => i !== index))}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    )
                  })}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-fit"
                    disabled={liveRoutes.every((candidate) =>
                      routes.some(
                        (route) => route.cli === candidate.cli && route.model === candidate.model
                      )
                    )}
                    onClick={() => {
                      const candidate = liveRoutes.find(
                        (live) =>
                          !routes.some(
                            (route) => route.cli === live.cli && route.model === live.model
                          )
                      )
                      if (candidate !== undefined) updateRoutes(taskKind, [...routes, candidate])
                    }}
                  >
                    <Plus size={12} /> Add route
                  </Button>
                </div>
              )
            })}
          </div>
        </details>
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
                      : /* "couldn't check" is not "not signed in". Telling an
                           operator who IS signed in to sign in sends them to fix
                           something that isn't broken. */
                        b.path === "undetermined"
                        ? "couldn't check"
                        : "not signed in"}
                </span>
                {/* Named explicitly: this is the case that used to cost money
                    without anyone noticing. */}
                {b.path === "undetermined" ? (
                  <span className="text-[11px] text-muted-foreground">
                    Starbase couldn&rsquo;t read this harness&rsquo;s credentials, so it left your
                    environment alone
                  </span>
                ) : null}
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
