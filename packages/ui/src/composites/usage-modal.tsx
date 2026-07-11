import type { CliKind, ProviderUsage, Usage, UsageStatus, UsageWindow } from "@starbase/core"
import { Gauge, RefreshCw } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog.js"
import { PROVIDER_COLOR, ProviderIcon } from "../components/provider-icon.js"

const fmtReset = (iso: string | null): string => {
  if (!iso) return "—"
  const d = new Date(iso)
  const day = d.toLocaleDateString(undefined, { weekday: "short" })
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return `Resets ${day} ${time}`
}

const fmtUsed = (u: number | null): string => (u == null ? "—" : `${Math.round(u)}% used`)

const fmtUpdated = (iso: string | null): string => {
  if (!iso) return "never"
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return "less than a minute ago"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} hr ago`
  return `${Math.floor(s / 86_400)} days ago`
}

const barColor = (status: UsageStatus, cli: CliKind): string =>
  status === "limited"
    ? "var(--sb-red)"
    : status === "nearing"
      ? "var(--sb-yellow)"
      : PROVIDER_COLOR[cli]

function WindowRow({ window: w, cli }: { window: UsageWindow; cli: CliKind }) {
  const pct = w.utilization == null ? 0 : Math.min(100, Math.max(0, w.utilization))
  return (
    <div className="flex items-center gap-4 py-2">
      <div className="w-[158px] flex-none">
        <div className="text-[12.5px] text-text-body">{w.label}</div>
        <div className="mt-0.5 text-[10.5px] text-muted-foreground">{fmtReset(w.resetsAt)}</div>
      </div>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: barColor(w.status, cli) }}
        />
      </div>
      <span className="w-[66px] flex-none text-right font-mono text-[11px] text-text-body">
        {fmtUsed(w.utilization)}
      </span>
    </div>
  )
}

function ProviderSection({ provider: p }: { provider: ProviderUsage }) {
  return (
    <div className="border-b border-hairline py-[18px] last:border-0">
      <div className="mb-3 flex items-center gap-[9px]">
        <ProviderIcon cli={p.cli} size={14} />
        <span className="text-[14px] font-semibold text-text-bright">{p.name}</span>
        {p.plan && (
          <Badge tone="neutral" size="sm">
            {p.plan}
          </Badge>
        )}
      </div>
      {p.available ? (
        p.windows.map((w) => <WindowRow key={w.label} window={w} cli={p.cli} />)
      ) : (
        <div className="text-[12px] text-muted-foreground">
          Usage data isn&apos;t available for this harness yet.
        </div>
      )}
    </div>
  )
}

/**
 * The Usage & limits modal: per-provider session/weekly windows as status-tinted
 * bars. Claude's data comes from rate-limit events captured as sessions run
 * (reset time + status; % when the provider reports it); others show as pending.
 */
export function UsageModal({
  open,
  usage,
  loading = false,
  onClose
}: {
  open: boolean
  usage?: Usage | null
  /** A usage fetch is in flight (the live read takes a couple of seconds). */
  loading?: boolean
  onClose?: () => void
}) {
  const providers = usage?.providers ?? []
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="w-[600px]">
        <DialogHeader>
          <Gauge size={16} className="text-blue" />
          <DialogTitle>Usage &amp; limits</DialogTitle>
        </DialogHeader>
        <DialogBody className="py-0">
          {providers.length > 0 ? (
            providers.map((p) => <ProviderSection key={p.cli} provider={p} />)
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
              <RefreshCw size={13} className="animate-spin" />
              Reading plan usage…
            </div>
          ) : (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              No harnesses detected on this machine.
            </div>
          )}
        </DialogBody>
        <DialogFooter className="justify-start text-[11px] text-muted-foreground">
          <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
          {loading && providers.length > 0 ? "Refreshing…" : `Last updated: ${fmtUpdated(usage?.fetchedAt ?? null)}`}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
