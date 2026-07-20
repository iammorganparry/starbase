---
"@starbase/ui": patch
---

Fixed: conversation panes sized to their content instead of filling their slot, stranding the composer mid-pane.

The grid slot added when sessions gained side-by-side layouts carried `min-h-0 min-w-0 flex-col` but no `flex-1`. Every wrapper above and below it was already `flex-1 min-h-0`, so height propagated the whole way down from `#root` and then stopped at the slot, which fell back to sizing itself to its content. The visible symptom was the message composer floating in the middle of a pane rather than pinned to its bottom edge — worst in a freshly-filled pane, where an empty transcript gives the slot almost no content to size to.

The slot now takes `flex-1 basis-0` rather than bare `flex-1`. The `basis-0` matters for the stacked layouts (`2|1`, `1|2`, `2|2`): with `flex-1` alone the two slots in a split column grow from their *content* heights, so a pane holding a long transcript and a pane holding an empty one divide the column unevenly. Starting both from zero makes them share it equally.

Also added the `min-h-0` that `conversation-view` and `session-conversation` were missing, so a tall transcript hands off to its own `overflow-auto` scroller rather than depending on the slot's `overflow-hidden` to contain it.

The new tests for this assert measured geometry — slot height against the grid container, composer bottom against its slot's — rather than behaviour. That is deliberate: the existing 91-test end-to-end suite passed throughout the bug's lifetime, because a pane rendered at half its height still holds the same sessions, answers the same clicks, and survives the same restarts. Layout regressions are only visible to assertions about boxes. All three new tests fail by 347px with the fix reverted.
