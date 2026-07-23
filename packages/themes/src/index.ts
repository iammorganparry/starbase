/**
 * `@starbase/themes` — the built-in themes and the fold that makes any VS Code
 * theme usable by Starbase.
 *
 * Deliberately free of Effect, filesystem access and React. It is imported by
 * the Electron MAIN process (to resolve the boot theme before a window exists),
 * by `cli-adapters` (to summarise what is installed) and by the RENDERER (to
 * preview a theme the operator is editing but has not saved). A dependency on
 * any one of those three worlds would put it out of reach of the other two.
 *
 * The stateful half — reading and writing `~/starbase/themes` — lives in
 * `ThemeService` in `@starbase/cli-adapters`.
 */
export * from "./color.js"
export * from "./ramp.js"
export * from "./map.js"
export * from "./css.js"
export * from "./shiki.js"
export * from "./presets/index.js"
