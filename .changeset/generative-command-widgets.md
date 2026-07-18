---
"@starbase/ui": minor
---

Command widgets — a bash tool call now renders as a card built for what it ran. A test run shows its scoreboard, the suite files and the first failing assertion; a build shows its bundle and warnings; a dev server shows its URLs; psql shows the query and its rows; and eight others besides.

Every widget rests as the familiar one-line row — the command, its outcome, a chevron — and opens into that card on demand, so a transcript still reads as a conversation rather than a stack of scoreboards. The row states the fact the widget actually learned: `2 failed · 3.20s` for a test run, `3 passed 1 running` for a check board, `4 rows` for a query. Anything unrecognised keeps the old collapsed log, intact.
