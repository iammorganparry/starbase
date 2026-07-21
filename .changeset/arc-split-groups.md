---
"@starbase/ui": minor
---

Rebuilt side-by-side sessions on Arc's group model: splits you build by dragging, not layouts you pick from a menu.

The preset grid is gone. It asked the operator to choose a shape (`1`, `1|1`, `2|1`, `2|2`) from a title-bar picker and then fill its slots, which meant the shape and its contents were two separate decisions and an empty slot was a legitimate resting state — a pane showing "Drag a session here" was something the app could sit in indefinitely. Arc and Dia answer this differently, and the difference is the whole point: a split is not a layout with holes in it, it is *these sessions, side by side*. You make one by dragging a session next to another, and it exists exactly as long as it has two or more sessions in it.

So the model is now a `Workspace` of `SplitGroup`s, each holding one to four panes with explicit width ratios (`packages/ui/src/app/split-layout.ts`, pure reducers). One sidebar row per group. **A group of one pane and a plain session are the same object** — there is no special case to render, because a lone session *is* a one-pane group. That single fact is what removes the empty slot: closing the second-to-last pane leaves a group of one, which is an ordinary row.

What that buys, concretely:

- **Drag anywhere.** A session dropped on a pane's outer eighth inserts a pane on that side; dropped on the middle it replaces what's there. The edge zones are deliberately narrow — replacing is the commoner intent, and a wide edge means every casual drop splits when you meant to swap.
- **One sidebar row per split**, rendered as Arc's pill: each pane a segment with its own status dot, title and close ×. At three panes and up the titles give way to dots (a 264px rail split four ways leaves ~50px a segment, which truncates "Refactor auth flow" to "R…"), and a hover peek card spells them out.
- **Right-click a pill** for "Split with ▸" and "Separate all tabs" — Arc's own wording, reached the same way.
- **Keyboard**, in one listener in `starbase-app.tsx`: `⌃⇧=` adds a pane, `⌃⇧1..4` focuses pane N, `⌃⇧[` / `⌃⇧]` move to the adjacent pane, `⌃⇧⌥←/→` move the focused *pane*, `⌃⇧W` closes it. Focus stops at the ends rather than wrapping — wrapping reads as a jump, and in a two-pane split it makes `[` and `]` indistinguishable.
- **Dividers you drag**, with the ratios persisted. Panes trade width continuously; both neighbours clamp at 15% so a hard drag parks the divider instead of collapsing a pane to nothing.

Motion (framer-motion v12) carries the transitions, with `MotionConfig reducedMotion="user"` at the app root so the whole thing honours the OS setting for free. Two things were learned the hard way and are commented where they bite: `layout` animation must be *off* while a divider is being dragged (a spring chasing the pointer feels like elastic), and a `motion` element must wrap a draggable child rather than be one, or `motion` claims `onDragStart` for its own pan gesture.

Existing arrangements are not lost. `sb.layout.v1` is read once and upgraded: the non-null slots become one group in column-major order, capped at four with equal ratios, focus preserved, written back as `sb.split.v2`.

Also here, because the same drag work surfaced it: the New Session repo field is searchable. It moved from Radix `Select` to `ChipMenu`, because `Select` swallows every keystroke for its own typeahead and so cannot host a filter input at all.

Deleted: `session-grid.tsx`, `layout-grid.ts`, `use-grid-layout.ts` and the title-bar `LayoutPicker`. The split is pure renderer state, exactly as the grid was — `packages/contracts`, `packages/cli-adapters` and the main process are untouched.
