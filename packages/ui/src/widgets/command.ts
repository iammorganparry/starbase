/**
 * Reading a shell command well enough to pick a widget for it.
 *
 * This is deliberately not a shell parser. It answers three questions —  which
 * program ran, what sub-command, with what arguments — for the ~95% of agent
 * commands that are a plain invocation, possibly behind a `cd x &&` or a package
 * manager. Anything hairier falls through to the generic widget, which is the
 * correct outcome rather than a degraded one.
 */

export interface ParsedCommand {
  /** The command exactly as the agent wrote it. */
  raw: string
  /**
   * The last `&&`/`;`-joined segment — the one whose output we're looking at.
   * `cd apps/web && pnpm test` → `pnpm test`.
   */
  primary: string
  /** `primary`'s tokens, with leading `VAR=value` assignments removed. */
  tokens: ReadonlyArray<string>
  /** The executable: `pnpm`, `git`, `vitest`. */
  bin: string
  /**
   * The program actually doing the work, with package-manager wrappers peeled
   * off: `pnpm exec vitest run` → `vitest`, `npx tsc` → `tsc`. Equals `bin` when
   * there's no wrapper.
   */
  program: string
  /** The first bare-word argument to `program`: `pnpm build` → `build`. */
  sub: string | null
  /** Every token after `program`, sub-command included. */
  args: ReadonlyArray<string>
}

/**
 * Package managers whose job is to run something else.
 *
 * `turbo` is here for `turbo run build`: it isn't a package manager, but it has
 * the same shape, and without it the sub-command parses as `run` and every
 * turbo task lands on the generic card.
 */
const RUNNERS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "pnpx", "bunx", "turbo"])

/**
 * `run` names a SCRIPT; `exec`/`dlx`/`x` name a BINARY. The difference decides
 * what the program is.
 *
 * `pnpm run test` is the same command as `pnpm test` — the program is still
 * pnpm and `test` is the script — whereas `pnpm exec vitest` really does run
 * vitest. Treating `run` as promoting (as this once did) gives `pnpm run test`
 * a program of "test" and no sub-command, so every widget keyed on the script
 * name silently misses and the card falls back to a plain log.
 */
const SCRIPT_RUNNERS = new Set(["run"])
const EXEC_RUNNERS = new Set(["exec", "dlx", "x"])
/** Runners that are themselves an exec wrapper: `npx tsc` needs no sub-command. */
const EXEC_BINS = new Set(["npx", "pnpx", "bunx"])

/** Package managers, for callers deciding whether a sub-command may be a binary. */
export const PKG_MANAGERS: ReadonlySet<string> = RUNNERS

/**
 * Split on `&&`, `;`, `||` — but not inside quotes.
 *
 * A `git commit -m "fix; ship it"` must not split at that semicolon. Pipes are
 * NOT split on: `vitest | tee` is still a vitest command, and its output is the
 * pipeline's.
 */
const segments = (command: string): string[] => {
  const out: string[] = []
  let buf = ""
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      buf += c
      if (c === quote && command[i - 1] !== "\\") quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      buf += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      out.push(buf)
      buf = ""
      i++
      continue
    }
    if (c === ";") {
      out.push(buf)
      buf = ""
      continue
    }
    buf += c
  }
  out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** `NODE_ENV=test pnpm vitest` → drop the assignment, keep the command. */
const stripEnv = (tokens: string[]): string[] => {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  return tokens.slice(i)
}

/** A bare word — a sub-command, not a flag, path, or assignment. */
const isBareWord = (t: string | undefined): t is string =>
  t !== undefined && /^[a-z][\w:.-]*$/i.test(t) && !t.startsWith("-")

export const parseCommand = (raw: string): ParsedCommand => {
  const segs = segments(raw)
  // `cd apps/web && pnpm test` — a lone `cd` sets up the real command; it never
  // produced the output we're rendering.
  const meaningful = segs.filter((s) => !/^cd\s/.test(s))
  const primary = (meaningful[meaningful.length - 1] ?? segs[segs.length - 1] ?? raw).trim()

  const tokens = stripEnv(primary.split(/\s+/).filter(Boolean))
  const bin = (tokens[0] ?? "").replace(/^.*\//, "") // ./node_modules/.bin/vitest → vitest
  let rest = tokens.slice(1)

  // Peel runner wrappers: `pnpm run test` / `pnpm exec vitest` / `npx tsc`.
  let program = bin
  if (RUNNERS.has(bin)) {
    /*
     * Find the script name by skipping everything that can't be one.
     *
     * Not "skip flags and their values" — that needs a table of which flags take
     * a value, and gets `pnpm --filter @starbase/ui test` wrong the moment a
     * value isn't a bare word. Scanning forward to the first bare word handles
     * flags, their values, and `-r`/`--silent` uniformly.
     */
    const nextWord = (from: number) => {
      let i = from
      while (i < rest.length && !isBareWord(rest[i])) i++
      return i
    }
    let i = nextWord(0)
    let exec = false
    const word = rest[i]
    if (word !== undefined && (SCRIPT_RUNNERS.has(word) || EXEC_RUNNERS.has(word))) {
      exec = EXEC_RUNNERS.has(word)
      i = nextWord(i + 1)
    }
    const head = rest[i]
    if (isBareWord(head)) {
      // Promote only for a genuine exec wrapper (`npx tsc`, `pnpm exec vitest`).
      // `pnpm test` and `pnpm run test` both keep pnpm as the program and leave
      // the script as the sub — that script name is the only thing identifying
      // what actually ran.
      if (exec || EXEC_BINS.has(bin)) {
        program = head
        rest = rest.slice(i + 1)
      } else {
        rest = rest.slice(i)
      }
    }
  }

  const sub = isBareWord(rest[0]) ? rest[0] : null
  return { raw, primary, tokens, bin, program, sub, args: rest }
}

/**
 * Does this command run a program whose name matches `re`?
 *
 * True the obvious ways — `vitest run`, `npx vitest`, `pnpm exec vitest` — and
 * also for `pnpm vitest run`, where a package manager is handed a binary
 * directly rather than a script.
 *
 * That last case can't be resolved from the command line alone: `pnpm vitest`
 * is either the vitest binary or a script someone named "vitest", and only
 * package.json knows which. Accepting both is still correct, because under
 * either reading vitest is what ran — which is the only thing the caller is
 * asking about.
 */
export const invokes = (c: ParsedCommand, re: RegExp): boolean =>
  re.test(c.program) || (PKG_MANAGERS.has(c.bin) && c.sub !== null && re.test(c.sub))

/**
 * A duration the command printed about itself, normalised to a display string.
 *
 * We never time commands ourselves — the ToolCall model has no duration — so the
 * only honest source is what the tool said. Returns null when it said nothing,
 * and the footer simply omits it.
 */
export const scrapeDuration = (output: string | undefined): string | null => {
  if (!output) return null
  const patterns = [
    /\bbuilt in ([\d.]+\s*m?s)\b/i, // vite
    /\bDone in ([\d.]+\s*m?s)\b/i, // pnpm / yarn
    /\bready in ([\d.]+\s*m?s)\b/i, // vite dev
    /^\s*Duration\s+([\d.]+\s*m?s)\b/im, // vitest
    /^\s*Time:\s+([\d.]+\s*m?s)\b/im, // jest
    /\bin ([\d.]+m?s)\s*$/im // esbuild-ish
  ]
  for (const re of patterns) {
    const m = re.exec(output)
    if (m?.[1]) return m[1].replace(/\s+/g, "")
  }
  return null
}

/**
 * `exit 0` / `exit 1`, derived from status.
 *
 * The real exit code isn't in the model — only running/success/error — so this
 * is the most the footer can honestly claim. Null while running: a command that
 * hasn't finished has no exit code, and showing `exit 0` early would be a lie.
 */
export const exitLabel = (status: "running" | "success" | "error"): string | null =>
  status === "running" ? null : status === "success" ? "exit 0" : "exit 1"
