import { CommandWidget } from "../composites/command-widget.js"
import { LogLines } from "../components/log-lines.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { exitLabel, explanatoryMeta, scrapeDuration } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/**
 * W10 — the fallback: any command we have no special reading of.
 *
 * This is the floor of the system. It matches everything, so it must never
 * decline, and it must never claim more than "here is what it printed".
 *
 * It is also where every codex bash call lands, because codex sends no output —
 * only a `meta` of the true exit code. So this widget carries the weight of
 * reporting that code honestly (rather than the fabricated `exit 1` it used to)
 * and of surfacing an opencode failure's error message, which likewise arrives
 * only in `meta`.
 *
 * It once owned the collapsed row; the frame owns it now, so all ten widgets
 * rest as a one-liner and open on demand — the behaviour the plain tool card
 * always had. What stays here is the summary that row states for a raw log:
 * `exit 127 · 1.2s · 14 lines`, plus the adapter's error when there's no body to
 * put it in.
 */

export interface GenericCommandProps {
  command: string
  status: ToolCallStatus
  /** The adapter-reported exit meta (codex's real code), or null. */
  exit: string | null
  /** A non-code explanation the adapter gave — opencode's error message. */
  note: string | null
  lines: ReadonlyArray<string>
  duration: string | null
  /** True when the adapter elided the middle of a long log. */
  capped: boolean
}

/**
 * The adapter's "N characters omitted" marker, whatever the host locale grouped
 * the number as.
 *
 * The claude adapter builds it with `toLocaleString()`, so on a German or French
 * machine the count is `41.204` or `41 204` (with a narrow no-break space) — not
 * `41,204`. Matching only `[\d,]+` there fails silently, and the "middle elided"
 * note it exists to show never appears. Accept any digit-grouping run.
 */
const CAP_MARKER = /…\s*[\d.,\s  ]+\s*characters omitted\s*…/

export const parseGeneric = (ctx: ParseContext): GenericCommandProps => {
  const out = ctx.output ?? ""
  return {
    command: ctx.command.primary,
    status: ctx.status,
    exit: ctx.meta,
    note: explanatoryMeta(ctx.meta),
    lines: out === "" ? [] : out.replace(/\n+$/, "").split("\n"),
    duration: scrapeDuration(ctx.output),
    capped: CAP_MARKER.test(out)
  }
}

/** `exit 127 · 1.2s · 14 lines` — the collapsed row's whole story. */
const summary = (p: GenericCommandProps): string => {
  const n = p.lines.length
  return [exitLabel(p.status, p.exit) ?? "running…", p.duration, n > 0 ? `${n} ${n === 1 ? "line" : "lines"}` : null]
    .filter(Boolean)
    .join(" · ")
}

export function GenericCommandWidget(p: GenericCommandProps) {
  const n = p.lines.length

  return (
    <CommandWidget
      status={p.status}
      command={p.command}
      summary={
        <>
          {/* The error message, when the adapter gave one and there's no log to
              show it in — otherwise a failed codex/opencode call reads as blank. */}
          {/* max-w + truncate, NOT min-w-0: ToolCall wraps meta in a `shrink-0`
              span, so nothing here can shrink and a long opencode error would
              squeeze the command to nothing and push the chevron into the
              row's overflow clip — losing the toggle entirely. */}
          {p.note && n === 0 && (
            <span className="max-w-[45%] truncate text-red">{p.note}</span>
          )}
          <span className="flex-none">{summary(p)}</span>
        </>
      }
      footer={
        <span className={p.status === "error" ? "text-red" : p.status === "success" ? "text-green" : "text-yellow"}>
          {exitLabel(p.status, p.exit) ?? "running…"}
        </span>
      }
      footerMeta={
        n === 0 ? (
          // The adapter's error message if it gave one (a failed codex/opencode
          // call has no body); otherwise "No output.", distinct from "we didn't
          // capture it" — a blank body reads as a bug.
          <span className={p.note ? "text-red" : "text-dim"}>{p.note ?? "No output."}</span>
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
