/**
 * `STARBASE_SCRIPTED_AGENT` — the e2e/test switch that says "no real harness".
 *
 * When set, nothing in this package may spawn a coding CLI: the scripted adapter
 * stands in for the agent, usage skips its live poll, and the harness's command
 * list is fabricated rather than probed. That is what makes the e2e suite
 * hermetic — no auth, no network, no dependence on which CLIs the host happens
 * to have installed.
 *
 * Shared because "don't spawn" has to mean the same thing everywhere. It was
 * duplicated per-module, and the moment one caller forgot, the guarantee broke:
 * `Skills.list` grew a probe that spawned the operator's real `claude` — with
 * their real login — on every e2e launch.
 */
const SCRIPTED_ENV = "STARBASE_SCRIPTED_AGENT"

export const isScriptedEnv = (): boolean =>
  process.env[SCRIPTED_ENV] === "1" || process.env[SCRIPTED_ENV] === "true"
