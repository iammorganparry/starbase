import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { KeyValueRow } from "../components/kv-row.js"
import { StatusDot } from "../components/status-dot.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { cn } from "../lib/cn.js"
import { exitLabel, invokes } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W7 — a dev server: where it's listening, and what it's done since. */

const DEV_PROGRAMS = /^(vite|next|nuxt|remix|astro|webpack-dev-server)$/
/** `pnpm dev`, `pnpm dev:web`, `npm start` — the script name is the signal. */
const DEV_SCRIPTS = /^(dev|serve|start|dev:[\w-]+)$/
/* Local to this widget — NOT the exported PKG_MANAGERS from ./command.js,
 * which also includes npx/pnpx/bunx/turbo. A dev script is only ever invoked
 * by a real package manager (`pnpm dev`), so the wrapper bins would be noise. */
const SCRIPT_HOSTS = new Set(["pnpm", "npm", "yarn", "bun"])

export interface DevUrl {
  /** `Local`, `Network`, `External` — whatever the server called it. */
  label: string
  url: string
}

export interface DevLog {
  time: string
  event: "hmr update" | "page reload"
  file: string
}

export interface DevServerProps {
  command: string
  status: ToolCallStatus
  /** The adapter-reported exit meta (codex\'s real code), or null. */
  exit: string | null
  /** `VITE`, `Next.js`. Null when the banner wasn't recognised. */
  tool: string | null
  version: string | null
  readyIn: string | null
  urls: ReadonlyArray<DevUrl>
  logs: ReadonlyArray<DevLog>
  /** Derived from the Local URL — the one number worth putting in the footer. */
  port: string | null
}

/** `  VITE v5.3.1  ready in 412 ms` / `  ▲ Next.js 14.2.3`. */
const banner = (out: string): { tool: string; version: string | null } | null => {
  const vite = /^\s*(VITE)\s+v([\d.]+[\w.-]*)/im.exec(out)
  if (vite) return { tool: vite[1]!, version: vite[2]! }
  const next = /^\s*(?:▲\s*)?(Next\.js)\s+v?([\d.]+[\w.-]*)/im.exec(out)
  if (next) return { tool: next[1]!, version: next[2]! }
  return null
}

/**
 * `➜  Local:   http://localhost:5173/` and next's `- Local:  http://localhost:3000`.
 *
 * Matching on "label + URL" rather than on either server's bullet glyph is what
 * makes one regex cover both — and nuxt/astro, which use their own glyphs but
 * the same two columns.
 */
const URL_LINE = /^\s*(?:[➜›▸*+-]\s*)?([A-Za-z][\w ]*?):\s+(https?:\/\/\S+)/gm

const devUrls = (out: string): DevUrl[] => {
  const urls: DevUrl[] = []
  for (const m of out.matchAll(URL_LINE)) {
    urls.push({ label: m[1]!.trim(), url: m[2]!.replace(/[,;]$/, "") })
  }
  return urls
}

/** `10:42:31 [vite] hmr update /src/routes/billing.tsx` — the tail that arrives later. */
const LOG_LINE = /^\s*(\d{1,2}:\d{2}:\d{2})\s+(?:\[[\w-]+\]\s*)?(hmr update|page reload)\s+(\S+)/gim

/**
 * Only the last few: a server that's been up all afternoon has hundreds of these
 * and the card is a status, not a log viewer. The tail is also the half that
 * survives the output cap.
 */
const LOG_TAIL = 5

const devLogs = (out: string): DevLog[] => {
  const logs: DevLog[] = []
  for (const m of out.matchAll(LOG_LINE)) {
    logs.push({
      time: m[1]!,
      event: m[2]!.toLowerCase() as DevLog["event"],
      file: m[3]!
    })
  }
  return logs.slice(-LOG_TAIL)
}

const portOf = (urls: ReadonlyArray<DevUrl>): string | null => {
  const local = urls.find((u) => /^local$/i.test(u.label)) ?? urls[0]
  return local ? (/:(\d+)/.exec(local.url)?.[1] ?? null) : null
}

export const parseDevServer = (ctx: ParseContext): DevServerProps | null => {
  const out = ctx.output
  /*
   * Bash output arrives once, whole, at exit — so a server that is still up has
   * printed nothing we can see, and in practice that is its entire life. Decline:
   * the plain card says "running, no output yet", which is the truth. Everything
   * below lights up on its own the day partial output starts arriving.
   */
  if (!out) return null

  const urls = devUrls(out)
  const b = banner(out)
  const readyIn = /\bready in\s+([\d.]+\s*m?s)\b/i.exec(out)?.[1]?.trim() ?? null
  // No address and no ready line: nothing here says "a server started". Decline.
  if (urls.length === 0 && readyIn === null) return null

  return {
    command: ctx.command.primary,
    status: ctx.status,
    exit: ctx.meta,
    tool: b?.tool ?? null,
    version: b?.version ?? null,
    readyIn,
    urls,
    logs: devLogs(out),
    port: portOf(urls)
  }
}

const eventClass = (event: DevLog["event"]) => (event === "page reload" ? "text-blue" : "text-green")

export function DevServerWidget(p: DevServerProps) {
  const listening = p.status === "running"
  /*
   * "done", not "live", while it's up: the blue live frame means "wait for this".
   * A server that's listening isn't pending — it has finished starting and is
   * doing its job. Once it exits, the tone is the exit's business again.
   */
  const tone = listening ? "done" : toneOf(p.status)
  return (
    <CommandWidget
      tone={tone}
      command={p.command}
      icon={listening ? <StatusDot tone="bg-green" size={9} pulse glow /> : undefined}
      headerMeta={
        listening ? <span className="text-green">listening</span> : <span className="text-dim">stopped</span>
      }
      footer={
        p.port ? (
          <span className="flex items-center gap-2">
            <StatusDot tone={listening ? "bg-green" : "bg-line-strong"} size={6} pulse={false} />:{p.port}
          </span>
        ) : undefined
      }
      /*
       * No uptime. We know when the process started only if someone told us, and
       * nobody did — the ToolCall model carries no duration. "uptime 4m 12s" would
       * be a number we made up, so the footer offers the one thing that's true.
       */
      footerMeta={listening ? <span className="text-dim">⌃C to stop</span> : (exitLabel(p.status, p.exit) ?? undefined)}
    >
      <WidgetBody className="gap-[9px]">
        {(p.tool || p.readyIn) && (
          <div className="font-mono text-[11.5px] leading-[1.6]">
            {p.tool && <span className="text-purple">{p.tool}</span>}
            {p.version && <span className="text-dim"> v{p.version}</span>}
            {p.readyIn && <span className="text-green">{p.tool ? " " : ""}ready in {p.readyIn}</span>}
          </div>
        )}

        {p.urls.length > 0 && (
          <div className="flex flex-col gap-[3px] pl-0.5">
            {p.urls.map((u) => (
              <KeyValueRow key={u.label + u.url} label={u.label} labelWidth={64}>
                {/local/i.test(u.label) ? (
                  // The one address you actually click. The others are for reading.
                  <a href={u.url} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                    {u.url}
                  </a>
                ) : (
                  u.url
                )}
              </KeyValueRow>
            ))}
          </div>
        )}

        {(p.logs.length > 0 || listening) && (
          <div className="flex flex-col gap-[5px] border-t border-line/25 pt-[9px] font-mono text-[11px] leading-[1.6]">
            {p.logs.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-none text-dim tabular-nums">{l.time}</span>
                <span className={cn("flex-none", eventClass(l.event))}>{l.event}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{l.file}</span>
              </div>
            ))}
            {listening && (
              <div className="flex items-center gap-2">
                <span className="flex-1 text-muted-foreground">watching for changes</span>
                <span className="inline-block h-[13px] w-1.5 flex-none bg-green [animation:var(--animate-caret)]" />
              </div>
            )}
          </div>
        )}
      </WidgetBody>
    </CommandWidget>
  )
}

export const devServerWidget = defineWidget<DevServerProps>({
  id: "dev-server",
  match: (c) =>
    invokes(c, DEV_PROGRAMS) ||
    // `npm run dev` promotes the script to `program`; `pnpm dev` leaves it as `sub`.
    DEV_SCRIPTS.test(c.program) ||
    (c.sub !== null && (DEV_SCRIPTS.test(c.sub) || (SCRIPT_HOSTS.has(c.bin) && /\bdev\b/.test(c.sub)))),
  parse: parseDevServer,
  render: (p) => <DevServerWidget {...p} />
})
