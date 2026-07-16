---
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Render GitHub PR review threads faithfully, and stop auto-mode swallowing the agent's questions.

- **Raw HTML no longer leaks as literal text.** `Markdown` passed `remarkPlugins`/`rehypePlugins` to Streamdown, which *replaces* its defaults rather than extending them — dropping `rehype-raw` (Streamdown then actively rewrites HTML to visible source, so Greptile's `<details>` blocks and `<picture>` badges rendered as markup) *and* `remark-gfm` (silently breaking tables, strikethrough, task lists and autolinks in every PR **and issue** body). Math now goes through Streamdown's `plugins.math` config, which appends after the defaults and preserves their array identity — which `allowedTags` requires to work at all.
- **Inline review threads.** The Pull Request tab now groups inline comments into GitHub-style review threads — a per-review header, a collapsible per-file box, the anchored diff hunk with old/new gutters, nested replies with Bot/Owner chips and reactions, and `Outdated`/`Resolved` badges. Sourced from GraphQL `reviewThreads` (`PullRequest.reviewThreads`); REST `/pulls/{n}/comments` cannot report resolution state at all. Resolved threads start collapsed, matching GitHub's "Show resolved".
- **Resolve / unresolve and reply** round-trip to GitHub via the new `Github.resolveThread` and `Github.replyToThread` RPCs.
- **Auto mode no longer discards the agent's questions.** `auto` mapped to the SDK's `bypassPermissions`, which skips the `canUseTool` callback entirely (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) — but that callback is also where `AskUserQuestion` and `ExitPlanMode` are intercepted, so questions were auto-approved, run headlessly and silently skipped, and the question card never docked. It now maps to `default`; gating is unchanged because the runner's own `verdict()` already allows everything in `auto`.
