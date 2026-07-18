---
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Adversarial review findings now act on themselves: the serious ones go to the working agent automatically, the small ones go on the pull request.

- **Critical and major findings are sent to the session's agent automatically**, as one batched turn through the session's conversation (so its work and any approval gates surface in the Conversation tab). No click. This fires for background sessions too — a reviewer that finds a data-loss bug on a session you aren't looking at now reaches its agent. The prompt tells the agent to assess each finding and push back rather than change correct code: the reviewer is asked to argue *against* the diff and report even what it doubts, so with nobody clicking Send, that instruction is what stands between a false positive and an unsupervised "fix".
- **Minor and nit findings are posted to the pull request** as one review with inline, line-anchored comments — new plumbing (`gh` could only post a top-level comment or a body-only review before). Anchors are checked against the diff first: GitHub rejects an *entire* review if one comment names a line outside it, so a finding the model mis-anchored folds into the review body instead of taking every other nit down with it. Posting is best-effort — a `gh` failure records itself on the review rather than discarding findings that cost real tokens.
- **Routing and posting are stamped on the stored review** (`routedAt` / `postedAt` / `postError`), so they survive a reload. Without that the auto-review poll would hand the same review back after a restart and re-send the whole batch to the agent, every time.
- **The file list marks which files carry feedback** — an icon and a count spanning adversarial findings, your unsubmitted drafts, and unresolved PR threads — and filters down to just those. (The old `commentCount` badge was hardcoded to 0 at every producer and could never render.)
- **Finding cards redesigned** — severity as a coloured rail rather than a badge per row, so the worst-first ranking reads before the words do; and each card now reports its own outcome ("Sent to agent" / "Posted to PR") instead of offering an action that already happened. The manual send survives as a fallback for the cases automation can't reach.
