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
 * Runner flags that take a SEPARATE value token — so `--filter web` is one unit
 * and `web` isn't mistaken for the script. `--filter=web` needs no entry (the
 * `=` keeps the value attached). Booleans like `-r`/`--silent` are absent by
 * design: they consume nothing.
 */
const VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--workspace",
  "--prefix"
  // Deliberately NOT `-w`: it's `--workspaces` (boolean) in yarn but takes a
  // value in some pnpm forms — ambiguous across managers, so leave it to the
  // bare-word fallback rather than guess wrong for one of them.
])

/** A command segment, and the operator that JOINED it to the previous one. */
interface Segment {
  text: string
  /** `null` for the first segment; otherwise what preceded this one. */
  op: "&&" | "||" | ";" | null
}

/**
 * Split on `&&`, `;`, `||` — but not inside quotes — keeping each operator.
 *
 * A `git commit -m "fix; ship it"` must not split at that semicolon. Pipes are
 * NOT split on: `vitest | tee` is still a vitest command, and its output is the
 * pipeline's. The operator is retained because it decides which segment
 * actually produced the output — `a && b` runs b, `a || b` runs b only if a
 * failed.
 */
const segments = (command: string): Segment[] => {
  const out: Segment[] = []
  let buf = ""
  let op: Segment["op"] = null
  let quote: string | null = null
  const push = (next: Segment["op"]) => {
    const text = buf.trim()
    if (text) out.push({ text, op })
    buf = ""
    op = next
  }
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
      push(two)
      i++
      continue
    }
    if (c === ";") {
      push(";")
      continue
    }
    buf += c
  }
  push(null)
  return out
}

/**
 * Split a segment into tokens, keeping a quoted span as ONE token.
 *
 * A plain `split(/\s+/)` tears `-H 'Referer: https://ref'` into three pieces
 * (`-H`, `'Referer:`, `https://ref'`), so a value-flag that means to consume its
 * whole argument only swallows the first word — and the URL hiding in the second
 * gets read as the request endpoint. Respecting quotes keeps the header value
 * intact as the single token the flag then skips. Quotes are retained on the
 * token; callers `unquote` when they need the bare value.
 */
const tokenize = (s: string): string[] => {
  const out: string[] = []
  let buf = ""
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      buf += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      buf += c
      continue
    }
    if (/\s/.test(c)) {
      if (buf) out.push(buf)
      buf = ""
      continue
    }
    buf += c
  }
  if (buf) out.push(buf)
  return out
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

/**
 * The segment whose output we're actually looking at.
 *
 * Walk from the end: the last segment ran unless it is an `||` arm, which runs
 * ONLY if its left side failed. `vitest run || true` prints the vitest log and
 * exits 0 via `true`; the output is vitest's, not `true`'s. So an `||` segment
 * is skipped in favour of what precedes it — the opposite of `&&`/`;`, where the
 * last segment is the one that ran. `cd x` is never the source: it only sets up.
 */
const primaryOf = (segs: Segment[]): string => {
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]!
    if (/^cd\s/.test(seg.text)) continue
    // This segment is the tail of an `||` chain — it only ran on failure, and
    // the output we see is more likely the left side's. Keep looking left.
    if (seg.op === "||") continue
    return seg.text
  }
  return segs[segs.length - 1]?.text ?? ""
}

export const parseCommand = (raw: string): ParsedCommand => {
  const segs = segments(raw)
  // `cd apps/web && pnpm test` — a lone `cd` sets up the real command; it never
  // produced the output we're rendering. And `vitest || true` swallows the exit
  // code without producing the log — see primaryOf.
  const primary = (primaryOf(segs) || raw).trim()

  const tokens = stripEnv(tokenize(primary))
  const bin = (tokens[0] ?? "").replace(/^.*\//, "") // ./node_modules/.bin/vitest → vitest
  let rest = tokens.slice(1)

  // Peel runner wrappers: `pnpm run test` / `pnpm exec vitest` / `npx tsc`.
  let program = bin
  if (RUNNERS.has(bin)) {
    /*
     * Skip past the runner's own flags to the script name.
     *
     * A first-bare-word scan looks simpler, but it mistakes an unscoped flag
     * VALUE for the script: `pnpm --filter web test` lands on `web`. So consume
     * the flags that take a separate value (`--filter web`, `-C dir`) as a pair,
     * and treat `--filter=web` / `-r` / `--silent` as self-contained.
     */
    const nextWord = (from: number) => {
      let i = from
      while (i < rest.length) {
        const t = rest[i]!
        if (!t.startsWith("-")) break
        // `--flag=value` and boolean flags consume only themselves; a
        // value-taking flag also swallows the next token.
        i += !t.includes("=") && VALUE_FLAGS.has(t) ? 2 : 1
      }
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

/** `exit 127` — an adapter reporting the real code, rather than us guessing one. */
const REAL_EXIT = /^exit\s+\d+$/i

/**
 * How the command ended, claiming only what we actually know.
 *
 * Three tiers, in order of honesty:
 *
 *  1. The adapter told us the code (codex sends `meta: "exit 127"`). Use it.
 *  2. It succeeded. `exit 0` is then a fact, not a guess — the harnesses report
 *     a non-zero exit as an error result.
 *  3. It failed and nobody said why. Say "failed".
 *
 * (3) is the point. This used to return `exit 1` for every error, which is
 * simply wrong most of the time — `command not found` is 127, a signal is 130,
 * tsc is 2 — and a fabricated code is worse than no code, because the operator
 * debugging from the transcript has no reason to doubt it.
 */
export const exitLabel = (status: "running" | "success" | "error", meta?: string | null): string | null => {
  if (meta && REAL_EXIT.test(meta.trim())) return meta.trim().toLowerCase()
  // A command that hasn't finished has no exit code; `exit 0` here would be a lie.
  if (status === "running") return null
  return status === "success" ? "exit 0" : "failed"
}

/**
 * An adapter's `meta` that explains a result, as opposed to restating its code.
 *
 * `exit 127` is already rendered as the exit label, so repeating it would be
 * noise; opencode's `permission denied` is the only account of the failure that
 * exists and has nowhere else to go.
 */
export const explanatoryMeta = (meta: string | null | undefined): string | null =>
  meta && !REAL_EXIT.test(meta.trim()) ? meta.trim() : null
