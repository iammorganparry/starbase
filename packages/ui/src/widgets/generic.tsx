import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { CommandWidget, toneOf } from "../composites/command-widget.js"
import { CommandLine } from "../components/command-line.js"
import { LogLines } from "../components/log-lines.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel, scrapeDuration } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/**
 * W10 — the fallback: any command we have no special reading of.
 *
 * This is the floor of the system. It matches everything, so it must never
 * decline, and it must never claim more than "here is what it printed".
 *
 * Alone among the widgets it collapses. The other nine ARE summaries — a
 * scoreboard, a bundle table — and are already worth their height. This one is a
 * raw log, so it stays a one-liner until asked, which is how the plain tool card
 * behaved and what the design draws.
 */

export interface GenericCommandProps {
  command: string
  status: ToolCallStatus
  lines: ReadonlyArray<string>
  duration: string | null
  /** True when the adapter elided the middle of a long log. */
  capped: boolean
}

const CAP_MARKER = /…\s*[\d,]+\s*characters omitted\s*…/

export const parseGeneric = (ctx: ParseContext): GenericCommandProps => {
  const out = ctx.output ?? ""
  return {
    command: ctx.command.primary,
    status: ctx.status,
    lines: out === "" ? [] : out.replace(/\n+$/, "").split("\n"),
    duration: scrapeDuration(ctx.output),
    capped: CAP_MARKER.test(out)
  }
}

/** `exit 0 · 1.2s · 14 lines` — the collapsed row's whole story. */
const summary = (p: GenericCommandProps): string => {
  const n = p.lines.length
  return [exitLabel(p.status) ?? "running…", p.duration, n > 0 ? `${n} ${n === 1 ? "line" : "lines"}` : null]
    .filter(Boolean)
    .join(" · ")
}

export function GenericCommandWidget(p: GenericCommandProps) {
  const [expanded, setExpanded] = useState(false)
  const n = p.lines.length
  const toggle = () => setExpanded((v) => !v)

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={false}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-xl border bg-sunken px-3 py-2.5 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          p.status === "error" ? "border-red/35" : "border-line"
        )}
      >
        {p.status === "success" && <span className="flex-none text-green">✓</span>}
        {p.status === "error" && <span className="flex-none text-red">✗</span>}
        {p.status === "running" && <span className="flex-none text-yellow">·</span>}
        <CommandLine command={p.command} className="flex-1" />
        <span className="flex-none font-mono text-[10.5px] text-dim">{summary(p)}</span>
        <ChevronRight className="size-3 flex-none text-blue" />
      </button>
    )
  }

  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      headerMeta={
        <button
          type="button"
          onClick={toggle}
          aria-expanded
          aria-label="Collapse output"
          className="flex items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className="size-3 text-dim" />
        </button>
      }
      footer={
        <span className={p.status === "error" ? "text-red" : p.status === "success" ? "text-green" : "text-yellow"}>
          {exitLabel(p.status) ?? "running…"}
        </span>
      }
      footerMeta={
        n === 0 ? (
          // Distinct from "we didn't capture it" — a blank body reads as a bug.
          <span className="text-dim">No output.</span>
        ) : (
          <span className="text-dim">
            stdout · {n} {n === 1 ? "line" : "lines"}
            {/* Say when the middle was cut. A silent elision reads as "that's
                all it printed", which is the one thing it isn't. */}
            {p.capped && " · middle elided"}
          </span>
        )
      }
    >
      {n > 0 && (
        <div className="max-h-[320px] overflow-auto px-4 py-3">
          <LogLines lines={p.lines} />
        </div>
      )}
    </CommandWidget>
  )
}

export const genericWidget = defineWidget<GenericCommandProps>({
  id: "generic",
  match: () => true,
  parse: parseGeneric,
  render: (p) => <GenericCommandWidget {...p} />
})
