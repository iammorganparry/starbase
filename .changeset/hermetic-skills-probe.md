---
"@starbase/cli-adapters": patch
---

Stop spawning the operator's real `claude` to list its commands under the scripted-agent switch.

`STARBASE_SCRIPTED_AGENT` means "no real harness" — it is what keeps the e2e suite hermetic: no auth, no network, no dependence on which CLIs the host happens to have installed. The scripted adapter honours it and usage honours it, but the `/` menu's command probe did not: it started the operator's real Claude, with their real login, on every launch — then failed or timed out, leaving the menu without its built-ins.

Under the switch we now answer for the fake harness, exactly as the scripted adapter answers for the real agent: Claude's own built-ins plus the skills scanned off disk (a real CLI announces file-based skills alongside its built-ins, so the stand-in reports both). `isScriptedEnv` is now shared rather than copied per-module — the copies were how one caller came to forget.
