---
"@starbase/ui": patch
---

Move splits above the repo groups in the sidebar

A split used to be drawn inside whichever repo group its first surviving pane
landed in. That was defensible while a split meant two sessions from one repo —
but you can split across repos, and then the pill claimed one repo as its home
while the other repo's session had no entry of its own.

Splits now sit in their own section directly under the filters, above every
group, because a split belongs to no repo. Their member sessions are held out of
the grouped lists before grouping, so a repo's count badge matches the rows
under it and a repo whose only sessions are in a split no longer renders an
empty heading.
