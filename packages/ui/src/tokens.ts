/**
 * Token helpers for JS-land. Colors themselves live in `globals.css` (One Dark)
 * and are consumed via Tailwind utilities (bg-panel, text-blue, …). These maps
 * translate domain enums to the right accent utility class.
 */
import type { PermissionMode, SessionStatus } from "@starbase/core"

/** Semantic accent per session/agent status → Tailwind text color utility. */
export const statusTextClass: Record<SessionStatus, string> = {
  thinking: "text-yellow",
  running: "text-blue",
  "needs-input": "text-blue",
  idle: "text-line-strong",
  done: "text-green"
}

/** Accent per status → Tailwind background color utility (for dots). */
export const statusDotClass: Record<SessionStatus, string> = {
  thinking: "bg-yellow",
  running: "bg-blue",
  "needs-input": "bg-blue",
  idle: "bg-line-strong",
  done: "bg-green"
}

/** Human label per status. */
export const statusLabel: Record<SessionStatus, string> = {
  thinking: "thinking…",
  running: "running",
  "needs-input": "needs input",
  idle: "idle",
  done: "done"
}

/** Whether a status should glow/pulse its dot. */
export const statusPulses = (s: SessionStatus): boolean =>
  s === "thinking" || s === "running"

/**
 * Semantic accent per HITL permission mode — used to "nightlight" the composer
 * (border + background tint + ambient glow) and colour the mode chip so the
 * active mode is legible at a glance. ask=blue, accept-edits=green, auto=orange
 * (more autonomy), plan=purple (the special, Claude-only mode). Glows reuse the
 * arbitrary box-shadow idiom from status-dot.tsx (an sb-colour CSS var).
 */
export const modeAccent: Record<
  PermissionMode,
  { border: string; bg: string; glow: string; chip: string; dot: string }
> = {
  ask: {
    border: "border-blue/50",
    bg: "bg-blue/5",
    glow: "shadow-[0_0_10px_-2px_var(--sb-blue)]",
    chip: "border-blue/40 text-blue",
    dot: "bg-blue"
  },
  "accept-edits": {
    border: "border-green/50",
    bg: "bg-green/5",
    glow: "shadow-[0_0_10px_-2px_var(--sb-green)]",
    chip: "border-green/40 text-green",
    dot: "bg-green"
  },
  auto: {
    border: "border-orange/55",
    bg: "bg-orange/5",
    glow: "shadow-[0_0_10px_-2px_var(--sb-orange)]",
    chip: "border-orange/40 text-orange",
    dot: "bg-orange"
  },
  plan: {
    border: "border-purple/55",
    bg: "bg-purple/8",
    glow: "shadow-[0_0_12px_-2px_var(--sb-purple)]",
    chip: "border-purple/40 text-purple",
    dot: "bg-purple"
  }
}
