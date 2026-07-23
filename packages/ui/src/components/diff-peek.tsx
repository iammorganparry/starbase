import { cn } from "../lib/cn.js"

/**
 * A compact inline unified-diff hunk shown under an `Edit`/`Write` tool card —
 * the "peek" from the design. Each line's FIRST character is the marker: `+`
 * added, `-` removed, ` ` (space) context, `…` a truncation gutter; the rest is
 * the code verbatim. Reading the marker positionally (not by sniffing the code)
 * means a context line that itself starts with `+`/`-` is never mis-tinted.
 */
export function DiffPeek({ preview, className }: { preview: string; className?: string }) {
  const lines = preview.replace(/\n+$/, "").split("\n")
  return (
    <div className={cn("bg-editor font-mono text-[11.5px] leading-[1.85]", className)}>
      {lines.map((raw, i) => {
        const marker = raw[0] ?? " "
        const added = marker === "+"
        const removed = marker === "-"
        const gutter = marker === "…"
        const known = added || removed || gutter || marker === " "
        const code = known ? raw.slice(1) : raw
        return (
          <div
            key={i}
            className={cn(
              "flex px-3",
              added && "bg-diff-add",
              removed && "bg-red/[0.13]"
            )}
          >
            <span
              className={cn(
                "w-3 shrink-0 select-none text-line-strong",
                added && "text-green",
                removed && "text-red"
              )}
            >
              {added ? "+" : removed ? "-" : ""}
            </span>
            <span
              className={cn(
                "whitespace-pre-wrap",
                added ? "text-green" : removed ? "text-red" : gutter ? "text-line-strong italic" : "text-muted-foreground"
              )}
            >
              {gutter ? `⋯ ${code}` : code}
            </span>
          </div>
        )
      })}
    </div>
  )
}
