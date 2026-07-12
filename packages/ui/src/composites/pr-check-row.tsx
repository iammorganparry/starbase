import type { PrCheck } from "@starbase/core"
import { Check, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"

/** Format a millisecond duration as a compact `1m 12s` / `48s` string. */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** One CI check row: status glyph · name · duration or a details link. */
export function PrCheckRow({ check }: { check: PrCheck }) {
  const running = check.status === "running"
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex w-3.5 flex-none items-center justify-center">
        {check.status === "pass" && <Check size={13} className="text-green" />}
        {check.status === "fail" && <X size={13} className="text-red" />}
        {running && <Spinner size={11} className="border-yellow border-t-transparent" />}
        {check.status === "pending" && <StatusDot tone="bg-line-strong" size={7} glow={false} />}
      </span>
      <span className={cn("flex-1 text-[13px]", running ? "text-text-bright" : "text-text")}>
        {check.name}
      </span>
      {check.detailsUrl && check.status === "fail" ? (
        <a
          href={check.detailsUrl}
          className="font-mono text-[10.5px] text-red hover:underline"
        >
          details
        </a>
      ) : running ? (
        <span className="font-mono text-[10.5px] text-yellow">running</span>
      ) : (
        check.durationMs !== null && (
          <span className="font-mono text-[10.5px] text-dim">
            {formatDuration(check.durationMs)}
          </span>
        )
      )}
    </div>
  )
}
