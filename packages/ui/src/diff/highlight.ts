import type { HighlighterCore } from "shiki/core"

/**
 * Syntax highlighting for diff bodies.
 *
 * A diff that paints every added line one flat green and every removed line one
 * flat red throws away the only signal that tells you what a line IS — you can
 * see that something changed but not whether it was a call, a string or a
 * comment. Keeping the tokens themed and expressing add/remove as a background
 * wash means the two axes stop competing for the same channel.
 *
 * ## Why the fine-grained build
 *
 * `import { codeToTokens } from "shiki"` pulls the FULL bundle — every grammar
 * and every theme shiki ships, which is tens of megabytes of JSON. The renderer
 * bundle is already 5.3MB and Vite warns about it. So:
 *
 * - `shiki/core` + `createHighlighterCore` — no grammars baked in.
 * - `createJavaScriptRegexEngine` rather than the oniguruma one, which avoids
 *   shipping (and instantiating) a WASM blob for something that runs on short
 *   diff hunks.
 * - Grammars are `import()`ed per language, on first use, and cached. Opening a
 *   TypeScript diff never loads the Python grammar.
 * - The CORE is dynamically imported too. Only the type is imported statically
 *   above (types are erased, so that costs nothing). Held as a static import it
 *   put ~300KB into the main chunk for a feature most sessions never reach —
 *   now the whole highlighter arrives on the first diff and never before.
 *
 * Everything here is async and best-effort: a language we don't bundle, a
 * grammar that fails to load, or the highlighter still warming up all degrade to
 * unhighlighted text rather than to an error. A diff that renders plainly is a
 * minor disappointment; a diff that doesn't render is a broken review.
 */

/** The theme, chosen to match the app's own One Dark palette. */
const THEME = "one-dark-pro"

/**
 * The grammars worth bundling, keyed by the extensions that map to them.
 *
 * Deliberately a short list. Every entry is a lazily-imported chunk, so the cost
 * of an unused one is a few bytes of module graph — but the cost of a MISSING
 * one is only that its diffs render plainly, which is exactly the pre-existing
 * behaviour. Add languages when they start showing up in real diffs, not in
 * anticipation.
 */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  md: "markdown",
  mdx: "markdown",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  toml: "toml"
}

/** Filenames with no useful extension that still deserve a grammar. */
const LANG_BY_FILENAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  ".gitignore": "shellscript",
  ".env": "shellscript"
}

const LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  yaml: () => import("@shikijs/langs/yaml"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  docker: () => import("@shikijs/langs/docker"),
  make: () => import("@shikijs/langs/make")
}

/**
 * The grammar for a path, or null when we don't bundle one.
 *
 * Null is a first-class answer, not a failure: it means "render this plainly",
 * which every caller already had to handle for the async window anyway.
 */
export const langForPath = (path: string): string | null => {
  const file = path.split("/").pop()?.toLowerCase() ?? ""
  const byName = LANG_BY_FILENAME[file]
  if (byName) return byName
  // `split(".").pop()` on a dotfile like `.env` returns "env", not "", so the
  // filename table above has to be consulted FIRST or `.env` would look like an
  // extension we don't know rather than the shell script it is.
  const ext = file.includes(".") ? (file.split(".").pop() ?? "") : ""
  return LANG_BY_EXT[ext] ?? null
}

let corePromise: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

/**
 * The shared highlighter, created once for the whole app.
 *
 * A module-level singleton rather than per-component: creating one costs a theme
 * parse, and a four-pane split showing four diffs would otherwise pay it four
 * times over. Grammars accumulate on it, so the second TypeScript file in a
 * review is already warm.
 */
const core = (): Promise<HighlighterCore> => {
  corePromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript")
    ])
    return createHighlighterCore({
      themes: [import("@shikijs/themes/one-dark-pro")],
      langs: [],
      engine: createJavaScriptRegexEngine()
    })
  })()
  return corePromise
}

/** One themed run of characters within a line. */
export interface Token {
  readonly text: string
  /** A hex colour from the theme. Inline `style`, because it isn't a Tailwind token. */
  readonly color: string
}

/**
 * Tokenize `lines` as one document, returning one token array per input line.
 *
 * ## Why the whole body at once, and why that's slightly wrong
 *
 * Highlighting each line in isolation cannot work: a line inside a template
 * literal or a block comment is only a string or a comment BECAUSE of a line
 * above it. So the lines are joined and tokenized as a single document, which is
 * what gives multi-line constructs the context they need.
 *
 * The known imprecision: a hunk's added and removed lines are interleaved in
 * that document, so a diff that opens a string on a removed line and closes it
 * on an added one produces a stream no version of the file ever contained. Every
 * mainstream diff viewer has this same seam, and the failure mode is a few
 * mis-tinted tokens rather than anything incorrect about the diff itself.
 *
 * Resolves to `null` — never throws — when the language is unknown or the
 * grammar fails to load. Callers render plain text on null.
 */
export const tokenizeLines = async (
  lines: ReadonlyArray<string>,
  lang: string | null
): Promise<ReadonlyArray<ReadonlyArray<Token>> | null> => {
  if (lang === null || lines.length === 0) return null
  const load = LOADERS[lang]
  if (!load) return null

  try {
    const highlighter = await core()
    if (!loaded.has(lang)) {
      await highlighter.loadLanguage((await load()) as never)
      loaded.add(lang)
    }
    const { tokens } = highlighter.codeToTokens(lines.join("\n"), { lang, theme: THEME })
    // Shiki drops a trailing empty line; pad so index N of the result always
    // means input line N. A caller indexing past the end would otherwise render
    // its last row plain for no visible reason.
    const out = tokens.map((line) => line.map((t) => ({ text: t.content, color: t.color ?? "" })))
    while (out.length < lines.length) out.push([])
    return out
  } catch {
    // A grammar that fails to load must not take the diff down with it.
    return null
  }
}
