#!/bin/sh
# Sync node_modules with the lockfile whenever it changes under our feet (a pull,
# a merge, a branch switch) — so deps are never silently stale after moving HEAD.
# Best-effort: it warns but NEVER blocks the git operation.
#
# Args: $1 = old ref, $2 = new ref (the two sides to compare the lockfile across).
#
# Invoked by the post-merge / post-checkout hooks. Enabled repo-wide via
# `core.hooksPath=.githooks` (set by the root `prepare` script on `pnpm install`).

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# The app's own session worktrees symlink node_modules to the origin checkout for
# speed; a real `pnpm install` there would clobber the symlink. Leave them alone —
# only sync checkouts that own a real node_modules (the dev repo + dev worktrees).
[ -L node_modules ] && exit 0

# Nothing to do unless the lockfile actually changed between the two refs.
if git diff --quiet "$1" "$2" -- pnpm-lock.yaml 2>/dev/null; then
  exit 0
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[starbase] pnpm-lock.yaml changed but pnpm isn't on PATH — run 'pnpm install' manually." >&2
  exit 0
fi

echo "[starbase] pnpm-lock.yaml changed — syncing deps (pnpm install)…"
pnpm install || echo "[starbase] ⚠ pnpm install failed — run 'pnpm install' manually." >&2
exit 0
