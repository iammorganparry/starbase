---
"@starbase/cli-adapters": patch
"@starbase/core": patch
---

Fixed: sessions inherited the launching repo's package-manager config, and the session store could lose records.

**Sessions ran under the wrong repo's tooling.** Starbase is itself started through a pnpm script, and pnpm publishes its resolved configuration into the environment before running one — an `npm_config_*` variable for every setting in the launching repo's `.npmrc`, plus `PNPM_SCRIPT_SRC_DIR` and a `PATH` prefixed with that repo's `node_modules/.bin`. Every agent session inherited all of it, so a session working in a worktree installed under the *origin* repo's `.npmrc` and resolved binaries from the *origin* repo's `.bin`. Because environment variables outrank `.npmrc`, the worktree could not override them: writing the setting into its own `.npmrc` changed nothing. This is the environment counterpart of the cwd inheritance fixed previously, and it is now stripped at all five spawn sites. Credentials are untouched — registry auth lives in `~/.npmrc`, which every package manager reads directly, and the uppercase `NPM_CONFIG_*` form (npm's documented way to configure from the environment) is deliberately preserved.

**The session store could silently lose every record.** `sessions.json` was rewritten in place, and a parse failure folds to an empty list so a corrupt file cannot stop the app booting — together, any partial write meant total silent loss of the only record of which worktrees exist. Writes now go to a unique temp file and are renamed into place, which is atomic. Separately, every read-modify-write is serialised: two sessions created at once each read the list, forked a worktree (seconds), then appended to the list they had read, so the second silently discarded the first.

**Removed the `node_modules` symlink mirror.** New worktrees were given a `node_modules` built from symlinks into the origin repo's, to avoid duplicating dependencies. Two measurements retired it: it did not survive the first install an agent ran inside a session (33 of 39 live worktrees had a real `node_modules`, so it was inert in ~85% of cases), and it was not saving the disk it appeared to — package managers on APFS import via `clonefile`, so blocks are already shared copy-on-write, and deleting a "1.7 GB" worktree tree returned ~310 MB of real disk. A worktree is now a plain checkout and the agent installs when it needs to, which is what it was already doing.

Also fixed, in the surrounding worktree code:

- **`removeWorktreeAt` leaked registrations.** It found the owning repo by running git *inside* the worktree, so a directory deleted by hand left it with nothing to ask; it reported success having done nothing. Sessions now record their origin repo so the registration can still be pruned.
- **`create` could delete a live session's worktree.** It calls the same reclaim step as the PR and issue flows — which `rm -rf`s the target path — but lacked the guard those two carry. Auto-generated names were also seeded from `Date.now()` alone, so two untitled sessions created in the same millisecond were handed the same name.
- **Untitled sessions collided on Windows.** The used-name check split paths on a hardcoded `/` while paths are built with `path.join`, so on Windows it never matched and every untitled session in a repo resolved to one name.
- **Long titles broke session creation.** Slugs become directory names but PR and issue titles are unbounded, so a long one produced a path `git worktree add` rejected with `ENAMETOOLONG`.
