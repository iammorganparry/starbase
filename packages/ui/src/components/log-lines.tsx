import { cn } from "../lib/cn.js"

/**
 * Numbered output lines with the few tokens that carry meaning picked out.
 *
 * Deliberately NOT a syntax highlighter: it tints exactly three things a shell
 * log actually uses — a leading ✓/✗ and the words warn/error. Anything more
 * would be guessing at arbitrary program output and would get it wrong loudly.
 */
const LEVEL = [
  { re: /^(\s*)(✓|√)(\s)/, cls: "text-green" },
  { re: /^(\s*)(✗|×|✘)(\s)/, cls: "text-red" },
  { re: /^(\s*)(warn(?:ing)?)\b/i, cls: "text-yellow" },
  { re: /^(\s*)(error|fail(?:ed)?)\b/i, cls: "text-red" }
] as const

function LogLine({ text }: { text: string }) {
  for (const { re, cls } of LEVEL) {
    const m = re.exec(text)
    if (!m) continue
    // Every LEVEL pattern is ^-anchored with (indent)(token) as its first two
    // groups, so the token's span is just their lengths.
    const [, indent = "", token = ""] = m
    const end = indent.length + token.length
    return (
      <>
        {indent}
        <span className={cls}>{token}</span>
        {text.slice(end)}
      </>
    )
  }
  return <>{text}</>
}

export interface LogLinesProps {
  lines: ReadonlyArray<string>
  /** Show 1-based gutter numbers (the generic-command body does; log tails don't). */
  numbered?: boolean
  className?: string
}

/** A plain command's stdout — the fallback body, and the tail of a dev server. */
export function LogLines({ lines, numbered = true, className }: LogLinesProps) {
  const gutter = String(lines.length).length
  return (
    <div className={cn("font-mono text-[11px] leading-[1.5] text-muted-foreground", className)}>
      {lines.map((line, i) => (
        <div key={i} className="flex gap-2">
          {numbered && (
            <span className="flex-none select-none text-right text-dim tabular-nums" style={{ width: `${gutter}ch` }}>
              {i + 1}
            </span>
          )}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
            <LogLine text={line} />
          </span>
        </div>
      ))}
    </div>
  )
}
