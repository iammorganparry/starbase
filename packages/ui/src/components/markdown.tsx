import { Streamdown } from "streamdown"
import { cn } from "../lib/cn.js"

/**
 * Renders agent markdown as prose via `streamdown` — headings, bold, lists,
 * inline/blocked code, tables, etc. `parseIncompleteMarkdown` makes it safe to
 * render a half-streamed message (unclosed fences/bold don't flash broken).
 * Scoped to our One Dark tokens via the `.sb-md` wrapper (see globals.css).
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("sb-md text-[14.5px] leading-[1.65] text-text-body", className)}>
      <Streamdown parseIncompleteMarkdown shikiTheme={["one-dark-pro", "one-dark-pro"]}>
        {children}
      </Streamdown>
    </div>
  )
}
