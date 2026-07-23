import { useState } from "react"
import { Code2, Eye, ShieldAlert } from "lucide-react"
import { cn } from "../lib/cn.js"
import { SegmentedControl } from "./segmented-control.js"
import { Toggle } from "./toggle.js"

type View = "code" | "preview"

/**
 * A per-block, opt-in preview for an ```html fenced block in agent output. It
 * defaults to the raw **Code** view so the transcript stays plain text; toggling
 * to **Preview** renders the HTML in a sandboxed iframe.
 *
 * Safety: the iframe uses `srcDoc` with an empty `sandbox` (an opaque origin — no
 * scripts, no same-origin access, no top-level navigation). Scripts run ONLY
 * after the operator flips the per-block "Enable scripts" switch, which escalates
 * the sandbox to `allow-scripts` (still no `allow-same-origin`, so agent JS can't
 * reach the host renderer). This is the trusted-content boundary for HTML output.
 */
export function HtmlPreview({ code, className }: { code: string; className?: string }) {
  const [view, setView] = useState<View>("code")
  const [scripts, setScripts] = useState(false)
  return (
    <div className={cn("my-3 overflow-hidden rounded-md border border-line", className)}>
      <div className="flex items-center gap-2 border-b border-line bg-sunken px-2 py-1.5">
        <span className="mr-auto font-mono text-[10.5px] uppercase tracking-wide text-dim">html</span>
        {view === "preview" && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldAlert
              className={cn("size-3", scripts ? "text-yellow" : "text-dim")}
              aria-hidden
            />
            Enable scripts
            <Toggle
              checked={scripts}
              onCheckedChange={setScripts}
              aria-label="Enable scripts in the HTML preview"
            />
          </label>
        )}
        <SegmentedControl<View>
          value={view}
          onChange={setView}
          items={[
            { value: "code", label: <><Code2 className="size-3" /> Code</> },
            { value: "preview", label: <><Eye className="size-3" /> Preview</> }
          ]}
        />
      </div>
      {view === "code" ? (
        <pre className="sb-md m-0 overflow-x-auto px-3 py-2.5 text-[12px] leading-[1.6] text-text-body">
          {code}
        </pre>
      ) : (
        <iframe
          title="HTML preview"
          srcDoc={code}
          // Empty sandbox = opaque origin, no JS. Scripts only when opted in;
          // never `allow-same-origin`, so the frame can't reach the host.
          sandbox={scripts ? "allow-scripts" : ""}
          // `bg-white`, not a token: the frame renders the agent's own HTML,
          // which was almost certainly authored against a white page. Painting
          // it with our surface would silently restyle somebody else's document.
          className="block h-[360px] w-full border-0 bg-white"
        />
      )}
    </div>
  )
}
