import { cn } from "../lib/cn.js"

/**
 * Split a command into the part you read and the part you skim.
 *
 * Every widget header shows the command that produced it, and at a glance the
 * only thing that identifies the card is the program (`vitest`, `pnpm build`).
 * The flags are noise until you go looking for them, so the program stays
 * bright and the arguments recede — the same move `PathTarget` makes for paths.
 *
 * Sub-commands count as part of the name: `pnpm build` and `git commit` read as
 * one unit, not a program plus an argument.
 *
 * This is deliberately NOT parseCommand: that resolves what RAN (peeling
 * `pnpm --filter x test` down to the `test` script), which is the right answer
 * for routing and the wrong one for display — the header should echo the command
 * as typed, just with the leading noun brightened. So for `pnpm --filter x test`
 * this brightens only `pnpm` and lets the rest recede, where the registry
 * decides the script is `test`. The two intentionally diverge; keeping this a
 * self-contained display rule also lets the atom render in Storybook with no
 * parser dependency.
 */
const SUBCOMMAND_HOSTS = new Set(["pnpm", "npm", "yarn", "bun", "git", "gh", "cargo", "go", "docker", "turbo"])

export const splitCommand = (command: string): { head: string; rest: string } => {
  const tokens = command.trim().split(/\s+/)
  const [bin, second] = tokens
  if (!bin) return { head: command, rest: "" }
  // A sub-command is a bare word — `pnpm build`, not `pnpm --filter`.
  const takesTwo = SUBCOMMAND_HOSTS.has(bin) && second !== undefined && /^[a-z][\w:-]*$/i.test(second)
  const headLen = takesTwo ? 2 : 1
  return { head: tokens.slice(0, headLen).join(" "), rest: tokens.slice(headLen).join(" ") }
}

export interface CommandLineProps {
  command: string
  /** Truncate to a single line (headers) rather than wrapping. */
  truncate?: boolean
  className?: string
}

/** `❯ vitest run` — the prompt caret, the program, then its dimmed arguments. */
export function CommandLine({ command, truncate = true, className }: CommandLineProps) {
  const { head, rest } = splitCommand(command)
  return (
    <span className={cn("font-mono text-[12.5px]", truncate && "min-w-0 truncate", className)}>
      <span className="text-green">❯</span> <span className="text-text-bright">{head}</span>
      {rest && <span className="text-dim"> {rest}</span>}
    </span>
  )
}
