import { isValidElement, useMemo, type ReactNode } from "react"
import { Streamdown, type AllowedTags, type MathPlugin } from "streamdown"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import { cn } from "../lib/cn.js"
import { DiffPeek } from "./diff-peek.js"
import { HtmlPreview } from "./html-preview.js"

/**
 * Math support: `remark-math` parses `$…$` / `$$…$$` and `rehype-katex` renders
 * it to KaTeX HTML (styled by `katex/dist/katex.min.css`, imported in
 * `globals.css`).
 *
 * Declared via Streamdown's `plugins.math` and NOT via the `remarkPlugins` /
 * `rehypePlugins` props. Those props REPLACE Streamdown's defaults rather than
 * extending them, and the defaults are load-bearing:
 *   rehype: rehype-raw, rehype-sanitize, rehype-harden
 *   remark: remark-gfm, codeMeta
 * Dropping `rehype-raw` doesn't merely leave HTML unrendered — Streamdown
 * detects its absence and actively rewrites raw HTML into literal text, so
 * GitHub review bodies (Greptile's `<details>` blocks and `<picture>` badges)
 * render as visible source. Dropping `remark-gfm` silently kills tables,
 * strikethrough, task lists and autolinks everywhere.
 *
 * `plugins.math` appends after the defaults AND preserves their array identity,
 * which `allowedTags` below requires in order to take effect at all.
 */
const MATH_PLUGIN = {
  name: "katex",
  type: "math",
  remarkPlugin: remarkMath,
  rehypePlugin: rehypeKatex
} as const satisfies MathPlugin

const PLUGINS = { math: MATH_PLUGIN }

/**
 * Tags GitHub review bots rely on that rehype-sanitize's default schema strips.
 * Greptile folds its "Prompt To Fix With AI" into a `<details>` and ships its
 * P1/severity and "Fix in …" badges as `<picture><source>` + `<img>`.
 *
 * Streamdown merges this into the sanitize schema with a SHALLOW spread
 * (`attributes: { ...defaultSchema.attributes, ...allowedTags }`), so an entry
 * here REPLACES that tag's default attribute list rather than adding to it.
 * Never list a tag the default schema already handles: `img: ["align"]` would
 * drop `src` from `img`'s defaults, and rehype-harden then renders the
 * src-less image as "[Image blocked]". `align`/`alt` need no entry anyway —
 * they're already in the schema's global `"*"` attribute list.
 */
const ALLOWED_TAGS: AllowedTags = {
  details: [],
  summary: [],
  picture: [],
  // `srcSet` is the one attribute here that the global `"*"` list lacks.
  source: ["srcSet", "srcset", "type"]
}

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
 * Unwrap no-op `<a href="#">…</a>` anchors.
 *
 * Greptile wraps its severity badge in one (`<a href="#"><img alt="P1" …></a>`).
 * rehype-harden can't validate a bare "#": its fragment fast-path compares
 * `new URL("#", base).hash` — which is `""` — against `"#"`, fails, then falls
 * through to `new URL("#")`, which throws. The href is judged unsafe and the
 * badge renders with a literal "[blocked]" stamped next to it. Such an anchor
 * targets nothing, so unwrapping it is lossless and drops the artifact.
 */
const NO_OP_ANCHOR = /<a\s+href="#"\s*>([\s\S]*?)<\/a>/gi
const unwrapNoOpAnchors = (md: string): string => md.replace(NO_OP_ANCHOR, "$1")

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
  const source = useMemo(() => unwrapNoOpAnchors(children), [children])
  return (
    <div className={cn("sb-md text-[14.5px] leading-[1.65] text-text-body", className)}>
      <Streamdown
        parseIncompleteMarkdown
        plugins={PLUGINS}
        allowedTags={ALLOWED_TAGS}
        shikiTheme={["one-dark-pro", "one-dark-pro"]}
        components={COMPONENTS}
      >
        {source}
      </Streamdown>
    </div>
  )
}
