/**
 * One Dark Pro palette + tokens for the transactional email suite, resolved to
 * concrete values from the design system (Email Suite.dc.html / tokens/*.css).
 * Email clients don't support CSS variables, so every value is a literal here
 * and inlined at the call site.
 */

export const color = {
  /** Dark canvas behind the 560px email column (the reader-pane bg). */
  pageBg: "#16181d",
  /** The email card surface. */
  card: "#21252b",
  /** Sunken insets (code/URL boxes, metadata blocks). */
  sunken: "#282c34",
  /** Raised chips (step numbers). */
  raised: "#2c313a",

  borderStrong: "#181a1f",
  border: "#3e4451",

  heading: "#d7dae0",
  body: "#abb2bf",
  secondary: "#828997",
  caption: "#5c6370",
  muted: "#5c6370",
  faint: "#4b5263",
  link: "#61afef",

  accent: "#61afef",
  /** Text/icon colour on an accent fill (dark, per --accent-contrast). */
  accentContrast: "#282c34",

  blue: "#61afef",
  green: "#98c379",
  red: "#e06c75",
  yellow: "#e5c07b",
  purple: "#c678dd",

  tintBlue: "rgba(97,175,239,0.08)",
  tintBlueBorder: "rgba(97,175,239,0.3)",
  tintGreen: "rgba(152,195,121,0.13)",
  tintGreenBorder: "rgba(152,195,121,0.3)",
  tintRed: "rgba(224,108,117,0.06)",
  tintRedBorder: "rgba(224,108,117,0.3)",
  tintRedButtonBorder: "rgba(224,108,117,0.45)",
  tintPurple: "rgba(198,120,221,0.13)",
  tintPurpleBorder: "rgba(198,120,221,0.3)"
} as const

export const font = {
  sans: '"Hanken Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
} as const

export const radius = {
  xs: "4px",
  sm: "5px",
  md: "7px",
  lg: "9px",
  full: "999px"
} as const

/** Per-template accent eyebrow colour (matches the design's numbered labels). */
export const accentFor = {
  blue: color.blue,
  green: color.green,
  yellow: color.yellow,
  purple: color.purple
} as const
