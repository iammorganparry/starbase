import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel, invokes, scrapeDuration } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W5 — a bundle: what it weighs, and what the bundler grumbled about. */

/**
 * Programs that only ever build.
 *
 * Deliberately excludes `vite`, `next` and `turbo`: those run a dev server just
 * as readily, and bare `vite` is the dev case. For them the sub-command is the
 * only honest signal — `vite build` is caught by the `sub === "build"` arm
 * below, while bare `vite` correctly falls through to the dev-server widget.
 */
const BUILD_ONLY = /^(tsup|webpack|rollup|esbuild|parcel)$/

/** The ones that build or serve depending on what follows them. */
const AMBIGUOUS_BUNDLERS = /^(vite|next|nuxt|astro|turbo)$/

/** Size units bundlers actually print, kB through MiB. */
const UNIT = "(?:B|kB|KB|KiB|MB|MiB|GB|GiB)"

export interface BuildAsset {
  path: string
  size: string
  /** Null for assets the bundler didn't gzip — sourcemaps, mostly. */
  gzip: string | null
}

export interface BuildProps {
  command: string
  status: ToolCallStatus
  /** The adapter-reported exit meta (codex\'s real code), or null. */
  exit: string | null
  tool: string | null
  toolVersion: string | null
  modules: number | null
  assets: ReadonlyArray<BuildAsset>
  warnings: ReadonlyArray<string>
  duration: string | null
}

/**
 * `vite v5.3.1 building for production...` — the banner.
 *
 * Anchored on the whole phrase, not just `<tool> v<x.y.z>`, because the widget
 * prints the phrase back. webpack's banner is `webpack 5.89.0 compiled
 * successfully`; matching that loosely would have us captioning it "building for
 * production", which it never said. A tool with no banner simply gets no line.
 */
const BANNER = /^\s*([a-z][\w.-]*)\s+(v[\d][\w.-]*)\s+building for production/im

/** `✓ 1284 modules transformed.` */
const MODULES = /([\d,]+)\s+modules?\s+transformed/i

/**
 * `dist/index.html   1.24 kB │ gzip:   0.61 kB`
 *
 * The separator is a box-drawing `│` from a real terminal, but the same log
 * pasted through anything ASCII-ish arrives as `|`. Accept both. gzip is
 * optional: vite omits it for sourcemaps, and tsup never prints it at all.
 */
const ASSET_LINE = new RegExp(
  String.raw`^\s*(\S+\.[\w.]+)\s+([\d.,]+\s*${UNIT})(?:\s*[│|]\s*gzip:\s*([\d.,]+\s*${UNIT}))?\s*$`,
  "gim"
)

/** Rollup/vite prefix their warnings with `(!)`; most others say the word. */
const WARNING_LINE = /^\s*(?:\(!\)\s*|(?:warning|warn):\s*)(.+?)\s*$/gim

const tidySize = (s: string) => s.replace(/\s+/g, " ").trim()

const assetsOf = (out: string): BuildAsset[] => {
  const found: BuildAsset[] = []
  for (const m of out.matchAll(ASSET_LINE)) {
    found.push({ path: m[1]!, size: tidySize(m[2]!), gzip: m[3] ? tidySize(m[3]) : null })
  }
  return found
}

const warningsOf = (out: string): string[] => {
  const found: string[] = []
  for (const m of out.matchAll(WARNING_LINE)) {
    /*
     * Drop a trailing connective. vite's chunk-size warning ends "…after
     * minification. Consider:" and then lists bullets on the following lines —
     * which the widget doesn't show, leaving "Consider:" pointing at nothing.
     * Trimming the dangling clause isn't rewording the tool; keeping it would
     * promise a list we then withhold.
     */
    const text = m[1]!.replace(/[.,]?\s*(?:Consider|Try|See)\s*:?\s*$/i, "").trim()
    if (text && !found.includes(text)) found.push(text)
  }
  return found
}

export const parseBuild = (ctx: ParseContext): BuildProps | null => {
  const out = ctx.output
  // Nothing printed yet — a build with no assets and no duration is a widget
  // claiming a bundle it hasn't seen. Fall back to the plain card.
  if (!out) return null

  const assets = assetsOf(out)
  const duration = scrapeDuration(out)
  // No asset table and no "built in": whatever this is, it isn't a build we can
  // read. Decline rather than render an empty bundle.
  if (assets.length === 0 && !/\bbuilt in\b/i.test(out)) return null

  const banner = BANNER.exec(out)
  const modules = MODULES.exec(out)
  return {
    command: ctx.command.primary,
    status: ctx.status,
    exit: ctx.meta,
    tool: banner?.[1] ?? null,
    toolVersion: banner?.[2] ?? null,
    modules: modules?.[1] ? Number(modules[1].replace(/,/g, "")) : null,
    assets,
    warnings: warningsOf(out),
    duration
  }
}

/**
 * Asset name colour by extension — the entry HTML, the stylesheet and the chunks
 * separate at a glance in what is otherwise a wall of near-identical filenames.
 */
const nameColour = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase()
  if (ext === "html") return "text-cyan"
  if (ext === "css") return "text-yellow"
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "text-blue"
  return "text-text"
}

/** A monorepo build prints dozens of chunks; the widget is a summary, not the log. */
const MAX_ASSETS = 6

export function BuildWidget(p: BuildProps) {
  const shown = p.assets.slice(0, MAX_ASSETS)
  const more = p.assets.length - shown.length
  const running = p.status === "running"
  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      headerMeta={
        running ? (
          <span className="text-yellow">building</span>
        ) : p.warnings.length > 0 ? (
          <span className="text-yellow">
            {p.warnings.length} warning{p.warnings.length === 1 ? "" : "s"}
          </span>
        ) : p.duration ? (
          <span className="text-dim">{p.duration}</span>
        ) : undefined
      }
      footer={
        p.status === "error" ? (
          <span className="text-red">build failed</span>
        ) : p.duration ? (
          <span className="text-green">built in {p.duration}</span>
        ) : undefined
      }
      footerMeta={exitLabel(p.status, p.exit) ?? undefined}
    >
      <WidgetBody>
        {p.tool && (
          <div className="text-muted-foreground">
            <span className="text-purple">{p.tool}</span> <span className="text-dim">{p.toolVersion}</span> building
            for production…
          </div>
        )}

        {p.modules !== null && (
          <div className="text-green">✓ {p.modules.toLocaleString("en-US")} modules transformed</div>
        )}

        {shown.length > 0 && (
          <div className="flex flex-col">
            {shown.map((a) => (
              <div key={a.path} className="flex items-baseline gap-2">
                <span className={cn("min-w-0 flex-1 truncate", nameColour(a.path))}>{a.path}</span>
                <span className="w-[70px] flex-none whitespace-nowrap text-right text-text-bright">{a.size}</span>
                {/* w-28 + nowrap: "gzip 168.00 kB" overruns 96px at this size and
                    wraps the column onto a second line. */}
                <span className="w-28 flex-none whitespace-nowrap text-right text-dim">
                  {a.gzip ? `gzip ${a.gzip}` : ""}
                </span>
              </div>
            ))}
            {more > 0 && <div className="text-dim">+{more} more</div>}
          </div>
        )}

        {/* A left rule, matching a test failure and a SQL inset — NOT `Callout`.
            Callout is the app's bordered, tinted notice for dialogs and panels;
            dropped into a flat tool-call body it reads as a card floating on a
            card, and it was the last boxed thing left among the ten. */}
        {p.warnings.map((w) => (
          <div key={w} className="border-l-2 border-yellow/50 pl-2.5 text-yellow">
            {w}
          </div>
        ))}
      </WidgetBody>
    </CommandWidget>
  )
}

export const buildWidget = defineWidget<BuildProps>({
  id: "build",
  match: (c) =>
    invokes(c, BUILD_ONLY) ||
    c.sub === "build" ||
    /*
     * `pnpm vite build` — the package manager takes the binary directly, so the
     * task sits one token PAST `sub` (which is "vite"). Without this arm the
     * dev-server widget claims the command on its program name, and a
     * production build renders as a running server. `pnpm exec vite build` and
     * `npx vite build` promote vite to `program`, so `sub` above catches those.
     */
    (c.sub !== null && AMBIGUOUS_BUNDLERS.test(c.sub) && c.args[1] === "build"),
  parse: parseBuild,
  render: (p) => <BuildWidget {...p} />
})
