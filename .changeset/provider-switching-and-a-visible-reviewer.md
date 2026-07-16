---
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Switch provider from the model chip, real Codex models, and a reviewer you can actually watch.

- **Switch harness from the composer's model chip** — models are grouped under the harness that offers them, so picking one picks its provider too. Only installed harnesses are listed. Switching mid-session starts the new harness on a fresh thread (a Codex thread id means nothing to Claude), degrades Claude-only Plan mode to `ask`, and refetches the `/` menu, since skills are per-harness.
- **Codex's model list now comes from the Codex CLI itself** (`codex app-server` → `model/list`), so it is the real, current catalogue — `gpt-5.6-sol` and friends, with the CLI's own default first. The old path asked the OpenAI **API** for it, which needed an `OPENAI_API_KEY` that Codex users on ChatGPT subscription auth do not have, and returned a different vocabulary anyway — so it always fell through to a hardcoded list of models that no longer exist. Claude is unchanged: its aliases (`opus`/`sonnet`/`haiku`) are valid and stable.
- **Models are discovered at startup**, while the window paints and you sign in, so the chip is populated by the time you open a session. Deliberately fire-and-forget: a cold cache is a slower chip, never a slower app.
- **Watch the adversarial reviewer work** — it now appears in the agent tab bar as a "Reviewer" tab, streaming its activity like any sub-agent, and its tab survives a restart (its findings already did). Previously a multi-minute agent ran behind a bare spinner with its output discarded.
- **The review button reports where the reviewer is** — starting → reading → thinking → writing findings, with a live timer. No percentage: nothing in a review announces a total, and the findings arrive as one block at the very end, so a bar would be invented. It reports auto-reviews too, not just ones you started.
