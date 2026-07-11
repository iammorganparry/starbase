import { isValidElement } from "react"
import { Streamdown } from "streamdown"
import { cn } from "../lib/cn.js"
import { DiffPeek } from "./diff-peek.js"

/**
 * Renders agent markdown as prose via `streamdown` — headings, bold, lists,
 * inline/blocked code, tables, etc. `parseIncompleteMarkdown` makes it safe to
 * render a half-streamed message (unclosed fences/bold don't flash broken).
 * Scoped to our One Dark tokens via the `.sb-md` wrapper (see globals.css).
 *
 * A ```diff fenced block is rendered with our own `DiffPeek` (the same red/green
 * line view used elsewhere) instead of Streamdown's generic code-block chrome.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("sb-md text-[14.5px] leading-[1.65] text-text-body", className)}>
      <Streamdown
        parseIncompleteMarkdown
        shikiTheme={["one-dark-pro", "one-dark-pro"]}
        components={{
          pre: ({ children: pre }) => {
            const code = isValidElement<{ className?: string; children?: unknown }>(pre) ? pre : null
            const lang = /language-(\w+)/.exec(code?.props.className ?? "")?.[1]
            if (lang === "diff") {
              const text = String(code?.props.children ?? "").replace(/\n$/, "")
              return (
                <div className="my-3 overflow-hidden rounded-md border border-line">
                  <DiffPeek preview={text} />
                </div>
              )
            }
            // Non-diff code blocks: plain, styled by `.sb-md pre` (no chrome).
            return <pre>{pre}</pre>
          }
        }}
      >
        {children}
      </Streamdown>
    </div>
  )
}
