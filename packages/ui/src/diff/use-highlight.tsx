import * as React from "react"
import { toShikiTheme } from "@starbase/themes"
import { useOptionalThemeTokens, useThemeSyntax } from "../theme-provider.js"
import { langForPath, type Token, tokenizeLines } from "./highlight.js"

/**
 * The active theme, in the shape shiki wants — or null before it has loaded.
 *
 * Memoised on the theme's identity because building it copies the whole colour
 * table, and the hooks below run on every diff in every open pane.
 */
const useShikiTheme = () => {
  const raw = useThemeSyntax()
  // Optional, not strict: these hooks also run in Storybook and in the diff
  // test suite, neither of which mounts a provider. Both correctly fall back to
  // shiki's bundled One Dark Pro.
  const tokens = useOptionalThemeTokens()
  return React.useMemo(
    () => (raw && tokens ? toShikiTheme(raw, tokens) : null),
    [raw, tokens]
  )
}

/**
 * Highlight a whole diff body once, and hand each row its own tokens.
 *
 * Hoisted to the file/hunk level rather than done per row for two reasons. The
 * rows are virtualized, so a per-row hook would re-tokenize on every scroll —
 * and more importantly a line inside a template literal is only a string
 * because of a line above it, which a row that only ever sees itself can never
 * know.
 *
 * Returns `null` until the grammar has loaded (and forever, for a language we
 * don't bundle). Callers render plain text on null, which is exactly what the
 * diff did before highlighting existed.
 */
export function useDiffHighlight(
  lines: ReadonlyArray<string>,
  path: string | null
): ReadonlyArray<ReadonlyArray<Token>> | null {
  const [tokens, setTokens] = React.useState<ReadonlyArray<ReadonlyArray<Token>> | null>(null)

  // The identity of `lines` changes on every parent render (it's derived), so
  // the effect keys off the CONTENT. Joining is cheap next to tokenizing, and
  // it's the difference between highlighting once and highlighting forever.
  const key = React.useMemo(() => lines.join("\n"), [lines])
  const lang = React.useMemo(() => (path === null ? null : langForPath(path)), [path])
  const theme = useShikiTheme()

  React.useEffect(() => {
    if (lang === null) {
      setTokens(null)
      return
    }
    // Grammar loading is async and the user can scroll to another file — or
    // close the pane — before it lands. Without this guard the late resolve
    // paints one file's tokens onto another's rows.
    let live = true
    void tokenizeLines(key.split("\n"), lang, theme).then((result) => {
      if (live) setTokens(result)
    })
    return () => {
      live = false
    }
    // `theme` is in the deps so a theme switch re-tokenizes. Without it the
    // diff keeps the OLD theme's token colours until the file is reopened —
    // dark-theme syntax colours left sitting on a light panel.
  }, [key, lang, theme])

  return tokens
}

/**
 * The same thing for a MULTI-file diff: one grammar run per file, scattered back
 * onto the flat row array the virtualizer indexes into.
 *
 * Per-file rather than per-diff because the language is a property of the file —
 * a changeset touching a `.ts` and a `.css` is two documents that happen to be
 * printed one after another, and tokenizing them as one would hand the CSS to
 * the TypeScript grammar.
 *
 * Returns a sparse array aligned to `contents`: index N holds row N's tokens, or
 * undefined for a row whose file has no grammar (or hasn't loaded yet).
 */
export function useMultiFileHighlight(
  contents: ReadonlyArray<string | null>,
  paths: ReadonlyArray<string | null>
): ReadonlyArray<ReadonlyArray<Token> | undefined> {
  const [tokens, setTokens] = React.useState<ReadonlyArray<ReadonlyArray<Token> | undefined>>([])

  // Content-keyed, like the single-file hook: `contents` is derived and so has a
  // fresh identity every render, which would otherwise re-tokenize forever.
  //
  // The separators are control characters written as ESCAPES, never as literal
  // bytes. Both halves of that matter:
  //
  // - Control characters, because a separator has to be something that cannot
  //   occur in a file path or in a line of source. Two different changesets that
  //   flatten to the same key would make the second silently reuse the first's
  //   tokens, which is exactly what joining on a space did.
  // - Escapes, because a raw NUL in a `.tsx` file makes git treat the whole file
  //   as BINARY: it stops diffing, `git blame` and `git grep` skip it, and the
  //   file ships unreviewable. This one did, which is why the note is here.
  const key = React.useMemo(
    () => `${paths.join("\u0000")}\u0001${contents.join("\u0000")}`,
    [contents, paths]
  )
  const theme = useShikiTheme()

  React.useEffect(() => {
    let live = true

    // Group row indices by file, preserving order within each.
    const byPath = new Map<string, Array<number>>()
    contents.forEach((content, i) => {
      // `paths` is indexed in lockstep with `contents`, but `noUncheckedIndexedAccess`
      // is right to insist: a caller passing mismatched lengths would otherwise
      // key the map on `undefined` and hand every such row to one grammar.
      const path = paths[i]
      if (content === null || path === null || path === undefined) return
      const list = byPath.get(path)
      if (list) list.push(i)
      else byPath.set(path, [i])
    })

    void Promise.all(
      [...byPath].map(async ([path, indices]) => {
        const lines = indices.map((i) => contents[i] ?? "")
        const result = await tokenizeLines(lines, langForPath(path), theme)
        return { indices, result }
      })
    ).then((groups) => {
      if (!live) return
      const out: Array<ReadonlyArray<Token> | undefined> = new Array(contents.length).fill(undefined)
      for (const { indices, result } of groups) {
        if (!result) continue
        indices.forEach((rowIndex, n) => {
          out[rowIndex] = result[n]
        })
      }
      setTokens(out)
    })

    return () => {
      live = false
    }
    // `key` is the content fingerprint; the arrays themselves are read inside.
    // `theme` is listed so a theme switch re-tokenizes rather than leaving the
    // previous theme's colours on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, theme])

  return tokens
}

/**
 * One line of code, themed.
 *
 * `color` arrives as a hex string from the theme rather than a Tailwind class,
 * so it goes on `style`. That is the point of using a real theme: the tokens
 * carry One Dark Pro's own colours instead of an approximation of them.
 *
 * Falls back to the raw text when there are no tokens for this line — the async
 * window, an unbundled language, or a grammar that failed to load all land here.
 */
export function HighlightedLine({
  text,
  tokens
}: {
  text: string
  tokens: ReadonlyArray<Token> | undefined
}) {
  if (!tokens || tokens.length === 0) return <>{text}</>
  return (
    <>
      {tokens.map((token, i) => (
        // Index keys are correct here and only here: this list is a positional
        // decomposition of one immutable string, so a token's index IS its
        // identity. It is replaced wholesale or not at all.
        <span key={i} style={token.color ? { color: token.color } : undefined}>
          {token.text}
        </span>
      ))}
    </>
  )
}
