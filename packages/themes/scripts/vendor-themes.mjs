#!/usr/bin/env node
/**
 * Vendors VS Code's built-in colour themes into `src/presets/*.ts`.
 *
 * Run with `pnpm --filter @starbase/themes vendor` when refreshing against a
 * newer VS Code. The output is committed, so a normal build and a normal CI run
 * never touch the network.
 *
 * ## The include chain is the whole job
 *
 * VS Code's built-ins are fragments that inherit from each other:
 *
 *   dark_modern.json  →  dark_plus.json  →  dark_vs.json
 *
 * `dark_modern.json` on its own names about 90 workbench colours and ZERO
 * syntax rules — every `tokenColors` entry lives two files down the chain.
 * Fetching a theme without resolving `include` therefore yields something that
 * decodes fine, maps fine, and renders as grey mush, which is the worst kind of
 * bug because nothing errors.
 *
 * So: resolve `include` depth-first, then merge child OVER parent. `colors` is
 * a shallow key merge (the child wins per key). `tokenColors` is CONCATENATED
 * parent-then-child, because TextMate resolves the last matching rule and that
 * ordering is what makes a child's override actually override.
 *
 * ## Two other things that bite
 *
 * - These files are JSONC. Monokai opens with six lines of `//` comment before
 *   the first brace, so `JSON.parse` fails on the very first theme people ask
 *   for. We strip comments and trailing commas before parsing.
 * - Several themes omit `name` or `type` (Abyss has no `type`; Monokai has no
 *   `name`) because VS Code supplies both from the extension's `package.json`
 *   `contributes.themes` entry, which we are not fetching. The table below
 *   carries them, and they are applied AFTER the merge so a parent can never
 *   overwrite them.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { fileURLToPath } from "node:url"

const REF = process.env.VSCODE_REF ?? "main"
const RAW = `https://raw.githubusercontent.com/microsoft/vscode/${REF}/extensions`

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "presets")

/**
 * The vendored set — the popular subset, not all seventeen built-ins.
 *
 * `id` is the stable identifier used by `config.theme.activeId` and by user
 * theme filenames, so renaming one silently resets everybody's theme choice.
 * `name` and `type` fill the gaps VS Code fills from `package.json`.
 */
const PRESETS = [
  { id: "dark-modern", path: "theme-defaults/themes/dark_modern.json", name: "Dark Modern", type: "dark" },
  { id: "light-modern", path: "theme-defaults/themes/light_modern.json", name: "Light Modern", type: "light" },
  { id: "monokai", path: "theme-monokai/themes/monokai-color-theme.json", name: "Monokai", type: "dark" },
  { id: "solarized-dark", path: "theme-solarized-dark/themes/solarized-dark-color-theme.json", name: "Solarized Dark", type: "dark" },
  { id: "solarized-light", path: "theme-solarized-light/themes/solarized-light-color-theme.json", name: "Solarized Light", type: "light" },
  { id: "abyss", path: "theme-abyss/themes/abyss-color-theme.json", name: "Abyss", type: "dark" },
  { id: "high-contrast-dark", path: "theme-defaults/themes/hc_black.json", name: "High Contrast Dark", type: "hcDark" },
  { id: "tomorrow-night-blue", path: "theme-tomorrow-night-blue/themes/tomorrow-night-blue-color-theme.json", name: "Tomorrow Night Blue", type: "dark" }
]

/**
 * Strip `//` and block comments and trailing commas so `JSON.parse` accepts a
 * JSONC file.
 *
 * Character-by-character with a string-literal guard rather than a regex,
 * because `"url": "https://example.com"` contains `//` inside a string and a
 * regex that does not track quoting truncates the value to `"https:`.
 */
const parseJsonc = (text) => {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    out += ch
  }
  // Trailing commas before a closing brace/bracket.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

const fetchTheme = async (extPath) => {
  const url = `${RAW}/${extPath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
  return parseJsonc(await res.text())
}

/**
 * Fetch `extPath` and everything it includes, merged child-over-parent.
 *
 * Depth-first: resolve the parent completely, then layer this file on top.
 * A `seen` set guards against a cyclic `include`, which would otherwise fetch
 * forever rather than fail.
 */
const resolve = async (extPath, seen = new Set()) => {
  if (seen.has(extPath)) throw new Error(`Cyclic include at ${extPath}`)
  seen.add(extPath)

  const theme = await fetchTheme(extPath)
  if (!theme.include) return theme

  const parentPath = posix.normalize(posix.join(posix.dirname(extPath), theme.include))
  const parent = await resolve(parentPath, seen)

  const { include: _dropped, ...child } = theme
  return {
    ...parent,
    ...child,
    colors: { ...(parent.colors ?? {}), ...(child.colors ?? {}) },
    // Parent first: TextMate takes the LAST matching rule, so appending the
    // child's rules is what lets a child override a scope its parent styled.
    tokenColors: [...(parent.tokenColors ?? []), ...(child.tokenColors ?? [])],
    semanticTokenColors: {
      ...(parent.semanticTokenColors ?? {}),
      ...(child.semanticTokenColors ?? {})
    }
  }
}

/**
 * One Dark Pro is vendored from the installed `@shikijs/themes` rather than
 * from GitHub, because it is not a VS Code built-in — and because the diff
 * viewer ALREADY highlights with shiki's copy of it. Taking both the workbench
 * colours and the syntax rules from the same source is what stops the code in a
 * diff being themed by one One Dark Pro while the panel behind it is themed by
 * a subtly different one.
 *
 * `PIN` then overrides the surfaces, text ramp and accents with the exact
 * values already in `packages/ui/src/globals.css`.
 *
 * This pinning is not cosmetic. One Dark Pro is `DEFAULT_THEME_ID`: it is what
 * a fresh install runs, what every existing config resolves to, and what every
 * failure falls back to. If applying it changed a single pixel, then "the theme
 * system shipped" and "the theme failed to load" would both look like the app
 * quietly changing colour, and every Storybook snapshot would need rebaselining
 * for a feature that is supposed to be a no-op by default.
 *
 * Keys chosen to match the mapper's FIRST fallback for each token, so the fold
 * is exact rather than approximately right.
 */
const ONE_DARK_PIN = {
  "editor.background": "#282c34",
  "editor.foreground": "#abb2bf",
  "sideBar.background": "#21252b",
  "panel.background": "#1e2228",
  "terminal.background": "#1e2228",
  "titleBar.activeBackground": "#16181d",
  "editorGroupHeader.tabsBackground": "#2c313a",
  "editorGroup.border": "#181a1f",
  "panel.border": "#3e4451",
  "input.border": "#3e4451",
  "contrastBorder": "#4b5263",
  "foreground": "#c8ccd4",
  "editorLineNumber.foreground": "#5c6370",
  "descriptionForeground": "#828997",
  "tab.activeForeground": "#d7dae0",
  "editor.selectionBackground": "#3e4451",
  "terminal.ansiBlue": "#61afef",
  "terminal.ansiGreen": "#98c379",
  "terminal.ansiYellow": "#e5c07b",
  "terminal.ansiRed": "#e06c75",
  "terminal.ansiMagenta": "#c678dd",
  "terminal.ansiCyan": "#56b6c2",
  "terminal.ansiBrightYellow": "#d19a66",
  "terminal.ansiBlack": "#3f4451",
  "terminal.ansiWhite": "#abb2bf",
  "terminal.ansiBrightBlack": "#4b5263",
  "terminal.ansiBrightRed": "#e06c75",
  "terminal.ansiBrightGreen": "#98c379",
  "terminal.ansiBrightBlue": "#61afef",
  "terminal.ansiBrightMagenta": "#c678dd",
  "terminal.ansiBrightCyan": "#56b6c2",
  "terminal.ansiBrightWhite": "#e6e6e6",
  "terminalCursor.foreground": "#61afef",
  "scrollbarSlider.background": "#3e4451",
  "scrollbarSlider.hoverBackground": "#4b5263",
  // One Dark Pro ships `diffEditor.insertedTextBackground: "#00809b33"` — a
  // TEAL insert wash. Faithful to the theme, and not what Starbase's diff
  // viewer currently paints, which is `bg-green/[0.13]` / `bg-red/[0.12]`.
  // Since this preset is the default, taking the theme's own value here would
  // change the diff viewer's appearance on upgrade for every existing user.
  // Other themes still get their own `diffEditor.*`; only the default is
  // pinned, and for the same reason every other value here is.
  "diffEditor.insertedTextBackground": "#98c37921",
  "diffEditor.removedTextBackground": "#e06c751f",
  "gitDecoration.addedResourceForeground": "#4e6b45",
  "gitDecoration.deletedResourceForeground": "#6b4a4e",
  "textLink.activeForeground": "#7cc0f5"
}

const vendorOneDarkPro = async () => {
  const mod = await import("@shikijs/themes/one-dark-pro")
  const theme = mod.default ?? mod
  return {
    ...theme,
    name: "One Dark Pro",
    type: "dark",
    colors: { ...(theme.colors ?? {}), ...ONE_DARK_PIN }
  }
}

/** `dark-modern` → `darkModern`, so the emitted export is a valid identifier. */
const camel = (id) => id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

const emit = (preset, theme) => {
  // `name`/`type` last: several themes inherit a parent's name through the
  // merge, and Dark Modern inheriting "Dark+" would mislabel the picker.
  const body = { ...theme, name: preset.name, type: preset.type }
  delete body.include
  delete body.$schema

  return `/**
 * ${preset.name} — vendored from microsoft/vscode (MIT), ref \`${REF}\`.
 *
 * GENERATED by scripts/vendor-themes.mjs. Do not edit by hand; re-run the
 * script instead. Source: extensions/${preset.path}
 * Include chain resolved and flattened at vendor time.
 */
import type { VsCodeTheme } from "@starbase/core"

export const ${camel(preset.id)}: VsCodeTheme = ${JSON.stringify(body, null, 2)}
`
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true })

  const oneDark = await vendorOneDarkPro()
  const oneDarkPreset = { id: "one-dark-pro", path: "(from @shikijs/themes)", name: "One Dark Pro", type: "dark" }
  await writeFile(join(OUT_DIR, "one-dark-pro.ts"), emit(oneDarkPreset, oneDark), "utf8")
  console.log(
    `✓ ${"one-dark-pro".padEnd(22)} ${String(Object.keys(oneDark.colors).length).padStart(4)} colors  ${String(oneDark.tokenColors.length).padStart(3)} rules  (pinned to globals.css)`
  )

  for (const preset of PRESETS) {
    const theme = await resolve(preset.path)
    const colors = Object.keys(theme.colors ?? {}).length
    const rules = (theme.tokenColors ?? []).length
    if (rules === 0) {
      throw new Error(
        `${preset.id} resolved to zero tokenColors — the include chain did not flatten. ` +
          `Syntax highlighting would silently be blank.`
      )
    }
    await writeFile(join(OUT_DIR, `${preset.id}.ts`), emit(preset, theme), "utf8")
    console.log(`✓ ${preset.id.padEnd(22)} ${String(colors).padStart(4)} colors  ${String(rules).padStart(3)} rules`)
  }
  console.log(`\nWrote ${PRESETS.length + 1} presets to src/presets/`)
}

await main()
