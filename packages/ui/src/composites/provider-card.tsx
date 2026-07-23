import type { CliKind } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { ProviderIcon } from "../components/provider-icon.js"

/**
 * A provider (agent CLI) row in the Settings · Providers list — brand mark,
 * name + `kind` badge, a one-line `model · mode · reasoning` summary, and an
 * on/off status dot. Selecting it opens that provider's detail pane.
 */
export function ProviderCard({
  cli,
  label,
  summary,
  enabled,
  installed,
  selected,
  onSelect
}: {
  cli: CliKind
  label: string
  /** e.g. "Sonnet 4.5 · plan · Think hard", or "disabled" / "not installed". */
  summary: string
  enabled: boolean
  installed: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex items-center gap-3 rounded-md border px-2.5 py-2.5 text-left transition-colors",
        selected
          ? "border-blue/45 bg-surface shadow-[0_0_0_3px] shadow-blue/10"
          : "border-line bg-sunken hover:bg-surface",
        !enabled && "opacity-70"
      )}
    >
      <span className="flex size-8 flex-none items-center justify-center rounded-md bg-canvas">
        <ProviderIcon cli={cli} size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-text-bright">{label}</span>
          <span className="rounded bg-hover px-1.5 py-px font-mono text-[9px] text-muted-foreground">
            {cli}
          </span>
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-dim">{summary}</span>
      </span>
      <span
        className={cn(
          "flex flex-none items-center gap-1.5 text-[10.5px]",
          enabled && installed ? "text-green" : "text-dim"
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            enabled && installed ? "bg-green shadow-[0_0_6px] shadow-green" : "bg-line-strong"
          )}
        />
        {enabled ? (installed ? "on" : "missing") : "off"}
      </span>
    </button>
  )
}
