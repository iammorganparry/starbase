/**
 * Token helpers for JS-land. Colors themselves live in `globals.css` (One Dark)
 * and are consumed via Tailwind utilities (bg-panel, text-blue, …). These maps
 * translate domain enums to the right accent utility class.
 */
import type { SessionStatus } from "@starbase/core"

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
