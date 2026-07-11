import { cn } from "../lib/cn.js"

/**
 * A compact inline diff snippet shown under an `Edit` tool card — the "peek" from
 * the design. Each line may be prefixed with a line number; a leading `+`/`-`
 * (after any number) tints it added/removed. Full diffs live in the Changes rail.
 */
export function DiffPeek({ preview, className }: { preview: string; className?: string }) {
  const lines = preview.replace(/\n+$/, "").split("\n")
  return (
    <div className={cn("bg-editor font-mono text-[11.5px] leading-[1.85]", className)}>
      {lines.map((raw, i) => {
        const match = raw.match(/^\s*(\d+)?\s*([+-])?\s?(.*)$/)
        const num = match?.[1] ?? ""
        const sign = match?.[2] ?? ""
        const code = match?.[3] ?? raw
        const added = sign === "+"
        const removed = sign === "-"
        return (
          <div
            key={i}
            className={cn(
              "flex",
              added && "bg-green/[0.13]",
              removed && "bg-red/[0.13]"
            )}
          >
            <span className="w-8 shrink-0 pr-[9px] text-right text-line-strong">{num}</span>
            <span
              className={cn(
                "whitespace-pre-wrap",
                added ? "text-green" : removed ? "text-red" : "text-muted-foreground"
              )}
            >
              {sign ? `${sign} ${code}` : code}
            </span>
          </div>
        )
      })}
    </div>
  )
}
