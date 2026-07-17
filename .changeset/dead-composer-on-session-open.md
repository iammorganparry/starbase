---
"@starbase/desktop": patch
---

Fix a dead composer on session open — a prompt typed while a session loaded did nothing at all.

`Skills.list` asks the harness what commands it has, which means spawning the binary: hundreds of ms to seconds. That call sat inside the conversation's `loading` step, which handles almost no events — so for as long as the probe took, the composer looked alive but swallowed everything: the send vanished, Shift+Tab did nothing, and picking a model snapped the chip straight back.

The model catalogue already carried a comment warning about precisely this ("gating the transcript on a CLI probe would widen that hole from imperceptible to seconds"), so skills now get the treatment the catalogue already had: fetched out of band, applied when they land, blocking nothing. The `/` menu fills itself in a beat later. Loading also now honours a mode or harness picked mid-load, rather than dropping it.
