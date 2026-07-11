import type { CliKind } from "@starbase/core"
import { cn } from "../lib/cn.js"

/**
 * The Claude "sunburst" mark — tapered rays radiating from the centre. Built from
 * geometry (24×24, centred at 12,12) so it reads crisply at small sizes; rays
 * alternate length slightly for the logo's organic burst.
 */
const claudeSunburst = (): string => {
  const cx = 12
  const cy = 12
  const rays = 12
  const inner = 1.6
  const half = 0.95
  let d = ""
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 - Math.PI / 2
    const outer = i % 2 === 0 ? 11.4 : 9.2
    const p = a + Math.PI / 2
    const tx = (cx + Math.cos(a) * outer).toFixed(2)
    const ty = (cy + Math.sin(a) * outer).toFixed(2)
    const b1x = (cx + Math.cos(a) * inner + Math.cos(p) * half).toFixed(2)
    const b1y = (cy + Math.sin(a) * inner + Math.sin(p) * half).toFixed(2)
    const b2x = (cx + Math.cos(a) * inner - Math.cos(p) * half).toFixed(2)
    const b2y = (cy + Math.sin(a) * inner - Math.sin(p) * half).toFixed(2)
    d += `M${b1x} ${b1y}L${tx} ${ty}L${b2x} ${b2y}Z`
  }
  return d
}

/**
 * Brand marks for the coding-agent providers (24×24, `currentColor`). Claude is
 * the sunburst; OpenAI's blossom for Codex; Cursor's cube for Cursor Agent.
 */
const PATHS: Record<CliKind, string> = {
  claude: claudeSunburst(),
  codex:
    "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
  cursor:
    "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"
}

/** Human label for each provider. */
export const PROVIDER_LABEL: Record<CliKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor"
}

/**
 * Brand colours: Anthropic's clay orange for Claude; OpenAI and Cursor render
 * monochrome (their marks are black/white) so they read cleanly on dark.
 */
export const PROVIDER_COLOR: Record<CliKind, string> = {
  claude: "#d97757",
  codex: "#d7dae0",
  cursor: "#d7dae0"
}

export function ProviderIcon({
  cli,
  size = 14,
  mono = false,
  className
}: {
  cli: CliKind
  size?: number
  /** Inherit the surrounding `currentColor` instead of the brand colour. */
  mono?: boolean
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={mono ? undefined : { color: PROVIDER_COLOR[cli] }}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <path d={PATHS[cli]} />
    </svg>
  )
}
