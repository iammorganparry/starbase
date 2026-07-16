---
"@starbase/cli-adapters": patch
---

Code Review: show every file on a large PR, and its diff.

A large PR rendered exactly 100 files and not one line of change. Two separate silent failures, both in `gh`'s reads:

- **The file list capped at 100.** `gh pr view --json files` is GitHub's GraphQL `files(first: 100)`, which gh does not paginate — so the list *and* its `+/−` totals were truncated with no indication: a 176-file PR showed 100 files summing `+5516/−11226` instead of `+10871/−24491`. `prFiles` now reads the paginated REST `pulls/{n}/files` endpoint, which returns every file (to GitHub's own 3000-file ceiling).
- **The diff came back empty.** GitHub refuses a diff past 20k lines outright — `gh pr diff` exits non-zero with `HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)`. `readStdout` folds that to null exactly like any other failure, so `prDiff` returned `""` and the UI rendered every file with no changes and no error. `gh pr diff` stays the primary read (one call, authoritative); on failure the diff is now rebuilt from the per-file `patch`es of the same paginated REST read, which has no such ceiling. An empty diff is still a legitimate success and does not trigger the fallback.

Note: GitHub omits `patch`, and reports `0` additions/deletions, for individual files whose diff is oversized (a lockfile, say). Those files still appear — as a header-only entry — rather than vanishing from the diff, but their lines aren't counted, so the file-list totals can read slightly under the PR's own header figure.
