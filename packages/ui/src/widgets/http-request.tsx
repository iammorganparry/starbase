import type { ReactNode } from "react"
import { CommandWidget, WidgetBody, toneOf } from "../composites/command-widget.js"
import { LogLines } from "../components/log-lines.js"
import { Pill } from "../components/pill.js"
import { StatusDot } from "../components/status-dot.js"
import type { ToolCallStatus } from "../composites/tool-call.js"
import { exitLabel } from "./command.js"
import { defineWidget, type ParseContext } from "./types.js"

/** W8 — a request: what went out, what came back, and what it weighed. */

/*
 * `wget` is deliberately absent. It prints a transfer LOG (resolving…, saving
 * to 'file'), not the response — so the widget would render that log as a GET's
 * body, size the log's bytes, and stamp it with the ✓-response glyph, every
 * field about the wrong thing. Its log reads fine on the generic card.
 */
const CLIENTS = /^(curl|http|https|xh)$/

export interface ResponseHeader {
  name: string
  value: string
}

export interface HttpRequestProps {
  command: string
  status: ToolCallStatus
  /** The adapter-reported exit meta (codex\'s real code), or null. */
  exit: string | null
  method: string
  /** Empty when the command's URL isn't one we can pick out of the flags. */
  url: string
  /** Null without `-i`/`-I`/`-D -`: curl prints no status line by default. */
  code: number | null
  reason: string | null
  headers: ReadonlyArray<ResponseHeader>
  body: string | null
  /** The parsed body, or `undefined` when it isn't JSON. `null` is a valid body. */
  json: unknown
  bytes: number | null
}

/**
 * HTTP/2 dropped the reason phrase, so `HTTP/2 200` is all a modern curl prints.
 * The words carry the meaning for a reader skimming — "429" is a number, "Too
 * Many Requests" is an answer — so we supply them for the codes an agent
 * actually hits, and show the bare number for anything else rather than guess.
 */
const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable"
}

const STATUS_LINE = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*?))?\s*$/

/** Flags whose *value* is the next token — so it can't be mistaken for the URL. */
const VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary",
  "-o", "--output", "-w", "--write-out", "-u", "--user", "-A", "--user-agent", "-b", "--cookie"
])

/**
 * A URL, conservatively: a scheme, a `www.`, or a host:port we'd only ever be
 * calling (`localhost:9100/health`). Loose "has a dot in it" matching claims
 * `-o out.json`'s filename is the endpoint, which is worse than showing none.
 */
const URLISH = /^(?:https?:\/\/|www\.)\S+$|^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/\S*)?$/

const unquote = (t: string) => t.replace(/^["']|["']$/g, "")

const urlOf = (tokens: ReadonlyArray<string>): string => {
  for (let i = 1; i < tokens.length; i++) {
    const token = unquote(tokens[i]!)
    const flag = tokens[i - 1]!
    // `--url https://…` is the exception: there the flag's value IS the URL.
    if (VALUE_FLAGS.has(flag)) continue
    if (token.startsWith("-")) {
      const inline = /^--url=(.+)$/.exec(token)
      if (inline?.[1]) return unquote(inline[1])
      continue
    }
    if (URLISH.test(token)) return token
  }
  return ""
}

const methodOf = (command: string): string => {
  const explicit = /(?:^|\s)(?:-X|--request)(?:\s+|=)["']?([A-Za-z]+)/.exec(command)
  if (explicit?.[1]) return explicit[1].toUpperCase()
  // A body without a verb is a POST — curl's own default, not our invention.
  if (/(?:^|\s)(?:-d|--data|--data-raw|--data-binary|--json)(?:\s|=)/.test(command)) return "POST"
  return "GET"
}

export const parseHttpRequest = (ctx: ParseContext): HttpRequestProps | null => {
  const out = ctx.output
  if (!out) return null

  const lines = out.replace(/\r/g, "").split("\n")
  /*
   * The LAST status line, not the first.
   *
   * `curl -i -L` prints one header block per hop, so a redirect chain starts
   * with `301 Moved Permanently` and ends with the `200` whose body we show.
   * Reading line 0 pairs the 301 (or a `100 Continue`) with the final body — a
   * mismatched code/body presented as one response. The final block is the one
   * that produced the body.
   */
  let statusIdx = -1
  for (let i = 0; i < lines.length; i++) if (STATUS_LINE.test(lines[i]!.trim())) statusIdx = i
  const statusLine = statusIdx >= 0 ? STATUS_LINE.exec(lines[statusIdx]!.trim()) : null

  let headers: ResponseHeader[] = []
  let body: string
  if (statusLine) {
    const blank = lines.findIndex((l, i) => i > statusIdx && l.trim() === "")
    const end = blank === -1 ? lines.length : blank
    headers = lines.slice(statusIdx + 1, end).flatMap((l) => {
      const m = /^([\w-]+):\s*(.*)$/.exec(l)
      return m?.[1] ? [{ name: m[1].toLowerCase(), value: m[2]!.trim() }] : []
    })
    body = blank === -1 ? "" : lines.slice(blank + 1).join("\n").trim()
  } else {
    // The common case: `curl -s url` prints the body and nothing else.
    body = out.trim()
  }

  // No headers to show and nothing that came back — there's no response here to
  // render, only an error message the plain card shows better.
  if (!statusLine && body === "") return null

  const code = statusLine?.[1] ? Number(statusLine[1]) : null
  let json: unknown
  try {
    json = body === "" ? undefined : JSON.parse(body)
  } catch {
    // Not JSON — HTML, a plain string, a truncated log. Shown raw below.
    json = undefined
  }

  return {
    command: ctx.command.primary,
    status: ctx.status,
    exit: ctx.meta,
    method: methodOf(ctx.command.primary),
    url: urlOf(ctx.command.tokens),
    code,
    reason: statusLine?.[2]?.trim() || (code !== null ? (REASONS[code] ?? null) : null),
    headers,
    body: body === "" ? null : body,
    json,
    bytes: body === "" ? null : new TextEncoder().encode(body).length
  }
}

type CodeTone = "green" | "blue" | "yellow" | "red"

const toneOfCode = (code: number): CodeTone =>
  code < 300 ? "green" : code < 400 ? "blue" : code < 500 ? "yellow" : "red"

/** Spelled out, not interpolated: Tailwind reads these class names out of the
 *  source, so a `text-${tone}` would compile to nothing at all. */
const CODE_TEXT: Record<CodeTone, string> = {
  green: "text-green",
  blue: "text-blue",
  yellow: "text-yellow",
  red: "text-red"
}

/** `1.4 kB` — decimal kB, the unit every HTTP tool reports in. */
const formatBytes = (n: number): string =>
  n < 1000 ? `${n} B` : n < 1_000_000 ? `${(n / 1000).toFixed(1)} kB` : `${(n / 1_000_000).toFixed(1)} MB`

/**
 * The four headers worth the room.
 *
 * A real response carries fifteen, and fourteen of them (`date`, `server`,
 * `vary`, …) never change what you do next. These four do: what the body is,
 * where you were sent, what you have left, and how long it's good for.
 */
const PREFERRED = /^(?:content-type|location|cache-control|x-ratelimit-)/
const MAX_HEADERS = 4

const pickHeaders = (headers: ReadonlyArray<ResponseHeader>): ResponseHeader[] =>
  [...headers.filter((h) => PREFERRED.test(h.name)), ...headers.filter((h) => !PREFERRED.test(h.name))].slice(
    0,
    MAX_HEADERS
  )

/** Long enough to recognise an id, short enough not to reflow the card. */
const MAX_STRING = 40
/** The body is a glance, not the payload; the transcript keeps the whole thing. */
const MAX_LINES = 20

const punct = (text: string) => <span className="text-dim">{text}</span>

const scalar = (value: unknown): ReactNode => {
  if (typeof value === "string") {
    const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
    return <span className="text-green">"{clipped}"</span>
  }
  return <span className="text-orange">{String(value)}</span>
}

interface JsonLine {
  depth: number
  content: ReactNode
}

/**
 * A pretty-printer rather than a highlighter: we have already parsed the body,
 * so the tones come off the *values*, not off a regex guessing at them. Nothing
 * here can mis-colour a string that happens to look like a number.
 */
const jsonLines = (value: unknown, depth = 0, prefix: ReactNode = null, comma = false): JsonLine[] => {
  const tail = comma ? punct(",") : null
  const nest = (open: string, close: string, children: JsonLine[][]): JsonLine[] =>
    children.length === 0
      ? [{ depth, content: <>{prefix}{punct(open + close)}{tail}</> }]
      : [
          { depth, content: <>{prefix}{punct(open)}</> },
          ...children.flat(),
          { depth, content: <>{punct(close)}{tail}</> }
        ]

  if (Array.isArray(value))
    return nest("[", "]", value.map((v, i) => jsonLines(v, depth + 1, null, i < value.length - 1)))

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
    return nest(
      "{",
      "}",
      entries.map(([k, v], i) =>
        jsonLines(
          v,
          depth + 1,
          <>
            <span className="text-red">"{k}"</span>
            {punct(": ")}
          </>,
          i < entries.length - 1
        )
      )
    )
  }

  return [{ depth, content: <>{prefix}{scalar(value)}{tail}</> }]
}

function JsonBody({ value }: { value: unknown }) {
  const all = jsonLines(value)
  const shown = all.slice(0, MAX_LINES)
  const more = all.length - shown.length
  return (
    <div className="rounded-lg border border-line/25 bg-hairline px-3 py-2.5 font-mono text-[11.5px] leading-[1.65]">
      {shown.map((l, i) => (
        <div key={i} style={{ paddingLeft: l.depth * 12 }}>
          {l.content}
        </div>
      ))}
      {more > 0 && <div className="text-dim">+{more} more lines</div>}
    </div>
  )
}

export function HttpRequestWidget(p: HttpRequestProps) {
  return (
    <CommandWidget
      tone={toneOf(p.status)}
      command={p.command}
      /*
       * The glyph tracks the *response*, not the process: curl exits 0 having
       * been told "500 Internal Server Error", and a green ✓ over that reads as
       * the request having worked. The frame's tone still reports the command,
       * and the footer still says `exit 0`.
       */
      icon={
        p.status === "running" ? (
          <StatusDot tone="bg-yellow" size={9} pulse />
        ) : p.status === "error" || (p.code !== null && p.code >= 400) ? (
          <span className="text-red">✗</span>
        ) : (
          <span className="text-green">✓</span>
        )
      }
      headerMeta={
        p.code !== null ? (
          <span className={CODE_TEXT[toneOfCode(p.code)]}>
            {p.code} {p.reason}
          </span>
        ) : undefined
      }
      footer={
        p.status === "running" ? <span className="text-yellow">waiting…</span> : undefined
      }
      footerMeta={exitLabel(p.status, p.exit) ?? undefined}
    >
      <WidgetBody className="gap-2.5">
        <div className="flex items-center gap-2 font-mono text-[11.5px]">
          <span className="flex-none text-purple">{p.method}</span>
          {p.url && <span className="min-w-0 flex-1 truncate text-text">{p.url}</span>}
        </div>

        {(p.code !== null || p.bytes !== null) && (
          <div className="flex items-center gap-2 font-mono text-[11px]">
            {p.code !== null && (
              <Pill tone={toneOfCode(p.code)} dot={false} className="font-semibold">
                {p.code} {p.reason}
              </Pill>
            )}
            {/* No timing: curl only reports one under `-w`, and the ToolCall
                model has no clock of its own. An invented number would be the
                one thing on this card nobody could check. */}
            {p.bytes !== null && <span className="text-dim">{formatBytes(p.bytes)}</span>}
          </div>
        )}

        {p.headers.length > 0 && (
          <div className="flex flex-col gap-[3px] font-mono text-[11px] text-dim">
            {pickHeaders(p.headers).map((h) => (
              <div key={h.name} className="flex gap-2">
                <span className="w-[170px] flex-none text-muted-foreground">{h.name}</span>
                <span className="min-w-0 flex-1 truncate">{h.value}</span>
              </div>
            ))}
          </div>
        )}

        {p.body !== null &&
          (p.json !== undefined ? (
            <JsonBody value={p.json} />
          ) : (
            <div className="max-h-[220px] overflow-auto rounded-lg border border-line/25 bg-hairline px-3 py-2.5">
              <LogLines lines={p.body.split("\n")} numbered={false} />
            </div>
          ))}
      </WidgetBody>
    </CommandWidget>
  )
}

export const httpRequestWidget = defineWidget<HttpRequestProps>({
  id: "http-request",
  match: (c) => CLIENTS.test(c.program),
  parse: parseHttpRequest,
  render: (p) => <HttpRequestWidget {...p} />
})
