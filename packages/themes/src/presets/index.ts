/**
 * The themes that ship inside the bundle.
 *
 * Eight VS Code built-ins plus One Dark Pro, all vendored by
 * `scripts/vendor-themes.mjs` — see that script for the include-chain flattening
 * and for why One Dark Pro comes from shiki instead of GitHub.
 *
 * ## Why a subset and not all seventeen
 *
 * VS Code ships seventeen built-ins, and the long tail of them (Kimbie Dark,
 * Red, Monokai Dimmed, Quiet Light) exist for historical reasons more than
 * because anyone chooses them. Each one vendored is ~40KB in the renderer
 * bundle — which is already 5.3MB and warned about — for a swatch most
 * operators will scroll past. The ones here cover the grounds that matter:
 * two modern defaults, two light, a high-contrast, and the three most-installed
 * classics.
 *
 * Anything missing is one paste away: Settings › Themes takes VS Code theme
 * JSON directly, which is the entire point of storing the format we store.
 *
 * ## Order is the picker's order
 *
 * Not alphabetical. The default first, then the two VS Code defaults people
 * recognise, then dark classics, then light, then high contrast — so the grid
 * reads as "yours, the familiar ones, then the rest" rather than as a list that
 * happens to start with Abyss.
 */
import type { VsCodeTheme } from "@starbase/core"
import { abyss } from "./abyss.js"
import { darkModern } from "./dark-modern.js"
import { highContrastDark } from "./high-contrast-dark.js"
import { lightModern } from "./light-modern.js"
import { monokai } from "./monokai.js"
import { oneDarkPro } from "./one-dark-pro.js"
import { solarizedDark } from "./solarized-dark.js"
import { solarizedLight } from "./solarized-light.js"
import { tomorrowNightBlue } from "./tomorrow-night-blue.js"

export interface BuiltinTheme {
  /** Stable id. Persisted in `config.theme.activeId` — never rename one. */
  readonly id: string
  readonly theme: VsCodeTheme
}

export const BUILTIN_THEMES: ReadonlyArray<BuiltinTheme> = [
  { id: "one-dark-pro", theme: oneDarkPro },
  { id: "dark-modern", theme: darkModern },
  { id: "light-modern", theme: lightModern },
  { id: "monokai", theme: monokai },
  { id: "abyss", theme: abyss },
  { id: "tomorrow-night-blue", theme: tomorrowNightBlue },
  { id: "solarized-dark", theme: solarizedDark },
  { id: "solarized-light", theme: solarizedLight },
  { id: "high-contrast-dark", theme: highContrastDark }
]

export const BUILTIN_THEME_IDS: ReadonlyArray<string> = BUILTIN_THEMES.map((t) => t.id)

export const findBuiltinTheme = (id: string): BuiltinTheme | undefined =>
  BUILTIN_THEMES.find((t) => t.id === id)

export {
  abyss,
  darkModern,
  highContrastDark,
  lightModern,
  monokai,
  oneDarkPro,
  solarizedDark,
  solarizedLight,
  tomorrowNightBlue
}
