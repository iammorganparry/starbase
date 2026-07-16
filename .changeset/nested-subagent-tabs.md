---
"@starbase/cli-adapters": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Nested sub-agent tabs — a sub-agent that spawns its own sub-agents now gets them as tabs, at any depth.

- **Nested spawns open their own tab.** Previously only a `Task` from the MAIN agent opened a tab; a `Task` spawned *by* a sub-agent stayed a plain tool card, and the nested agent's output was **dropped entirely** — `applySubagentEvent` couldn't place an event whose `agentId` matched no open tab, and sub-agent events never reach the transcript store, so that output was unrecoverable rather than merely hidden.
- **The sub-agent list stays flat, and models the tree with a `parentId` pointer** rather than nested `children` arrays. The SDK stamps `parent_tool_use_id` with the *immediate* parent, so every agent already has a globally-unique id that events route to by a direct id match at any depth; the renderer derives the tree on read (`agentChildren` / `agentPath`).
- **The tab bar drills down instead of growing sideways.** A flat strip can't express depth, so it shows one level at a time: a breadcrumb of the drill path, then a cell per agent at that level, with a `>` affordance on any agent that spawned its own. The strip stays a fixed height at any depth.
- **An ancestor ending settles its still-working descendants.** Each nested agent normally gets its own `SubagentEnded` from its own `tool_result`, but an ancestor that errors or aborts can leave children with no result of their own — without this they'd pulse "working" forever.
- **Fixed: a finished sub-agent's tab pulsed its "working" dots forever.** A sub-agent's rolling message is born `streaming: true`, and only a `Done` event clears that — but `Done` is a MAIN-turn event (no `agentId`), so it never reached a sub-agent and *nothing* could settle its message. `SubagentEnded` now settles the message as well as the status, as does the end-of-run sweep for an interrupted turn (which flipped `status` only, while the spinner is driven by the message flag).
- **Fixed: backgrounded sub-agents settled ~150ms after spawn.** A `Task` run in the background returns its `tool_result` almost immediately — an "Async agent launched successfully" ACK, not a completion — so the tab read "done" while the agent actually ran for minutes. The tab now settles on the SDK's `task_notification` bookend (`system` / `subtype: 'task_notification'`), which carries the spawning `tool_use_id` and a `completed | failed | stopped` status, and fires at the true completion. Verified against the SDK that it fires for synchronous Tasks too (just before their `tool_result`), so it is the correct single settle signal either way; the end-of-run sweep still backstops an aborted run. These `system` messages were previously dropped wholesale by an `if (msg.subtype !== "init") return []`.

Sub-agents remain live-only (not disk-persisted), and token usage is still attributed to the main agent only — unchanged from before.
