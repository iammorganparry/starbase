---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
---

Fix a dead composer on session open — a prompt typed while a session loaded did nothing at all.

`Skills.list` asks the harness what commands it has, which means spawning the binary: hundreds of ms to seconds. That call sat inside the conversation's `loading` step, which handles almost no events — so for as long as the probe took, the composer looked alive but swallowed everything: the send vanished, Shift+Tab did nothing, and picking a model snapped the chip straight back.

The model catalogue already carried a comment warning about precisely this ("gating the transcript on a CLI probe would widen that hole from imperceptible to seconds"), so skills now get the treatment the catalogue already had: fetched out of band, applied when they land, blocking nothing. The `/` menu fills itself in a beat later.

Three follow-ons, because a window that swallows input is only really closed when nothing can fall into it:

- **A prompt sent before the transcript lands is now held and run**, exactly as a send during a run is. Dropping one was invisible — the box clears and you believe you sent it — and it survives a *failed* load too: losing the transcript is no reason to also lose what you typed.
- **A mode or harness picked mid-load is honoured** rather than dropped.
- **The skills probe honours `STARBASE_SCRIPTED_AGENT`.** That switch means "spawn no real harness", and the probe ignored it — so the e2e suite was starting the operator's real `claude`, with their real login, on every launch. It now answers for the fake harness instead, which is what made the suite depend on which CLIs the host happened to have installed.
