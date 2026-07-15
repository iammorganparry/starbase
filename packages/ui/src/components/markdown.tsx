import { isValidElement, type ReactNode } from "react"
import { Streamdown } from "streamdown"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import { cn } from "../lib/cn.js"
import { DiffPeek } from "./diff-peek.js"
import { HtmlPreview } from "./html-preview.js"

/**
 * Math support: `remark-math` parses `$…$` / `$$…$$` and `rehype-katex` renders
 * it to KaTeX HTML (styled by `katex/dist/katex.min.css`, imported in
 * `globals.css`). Declared once at module scope so the plugin arrays are stable
 * across renders (Streamdown re-runs the pipeline when they change identity).
 */
const REMARK_PLUGINS = [remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

/**
 * Our fenced-block overrides. A ```diff block renders as a `DiffPeek`, and a
 * ```html block renders as a per-block, opt-in sandboxed `HtmlPreview`.
 *
 * This MUST be a stable module-scope component (not an inline closure in
 * `Markdown`): Streamdown re-runs its pipeline on every render, so an inline
 * `pre` would be a new component TYPE each time and React would UNMOUNT the block
 * — resetting `HtmlPreview`'s Code/Preview toggle whenever the transcript
 * re-renders (e.g. the virtualizer re-measuring on a height change).
 */
function MarkdownPre({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children : null
  const lang = /language-(\w+)/.exec(code?.props.className ?? "")?.[1]
  if (lang === "diff") {
    const text = String(code?.props.children ?? "").replace(/\n$/, "")
    return (
      <div className="my-3 overflow-hidden rounded-md border border-line">
        <DiffPeek preview={text} />
      </div>
    )
  }
  if (lang === "html") {
    // Opt-in per-block: defaults to the raw Code view (plain text); the operator
    // can switch to a sandboxed Preview. See HtmlPreview.
    const text = String(code?.props.children ?? "").replace(/\n$/, "")
    return <HtmlPreview code={text} />
  }
  // Non-diff code blocks: plain, styled by `.sb-md pre` (no chrome).
  return <pre>{children}</pre>
}

const COMPONENTS = { pre: MarkdownPre }

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
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        shikiTheme={["one-dark-pro", "one-dark-pro"]}
        components={COMPONENTS}
      >
        {children}
      </Streamdown>
    </div>
  )
}
