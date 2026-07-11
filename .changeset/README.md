# Changesets

Starbase versions the **whole monorepo in lockstep**. Every `@starbase/*`
package (including `@starbase/desktop`) shares a single version — that version is
the released **app** version, read by electron-builder and shown in-app as
`__APP_VERSION__`. This is enforced by `fixed: [["@starbase/*"]]` in
`config.json`, so a single changeset naming any one package bumps them all.

Nothing is published to npm (all packages are `private`); Changesets is used only
as a **version + CHANGELOG** engine.

## Recording a change

When you make a user-facing change, add a changeset and commit it with your PR:

```bash
pnpm changeset
```

Pick `patch` / `minor` / `major` and write a one-line summary. It creates a
`.changeset/*.md` file — commit it. (Because of `fixed`, it doesn't matter which
`@starbase/*` package you select; the whole product moves together.)

```md
---
"@starbase/desktop": minor
---

One-line summary of the user-facing change.
```

## Cutting a release

Releases are cut **from `main`** by manually running the **Release** GitHub
Action (`workflow_dispatch`). It gates on typecheck + tests, then runs
`pnpm version-packages` (applies pending changesets, writes CHANGELOGs, and
mirrors the version into the root `package.json`), commits `release: vX.Y.Z`,
tags `vX.Y.Z`, pushes, then builds + publishes the desktop installers to a
GitHub Release. Shipped apps auto-update from that release feed via
electron-updater.
