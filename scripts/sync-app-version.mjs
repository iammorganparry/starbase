/**
 * Mirrors the desktop app's version (the single source of truth, bumped by
 * `changeset version`) into the root package.json so the repo version always
 * matches the shipped app version. Run as the second half of `version-packages`.
 *
 * The `@starbase/*` workspace packages move in lockstep (Changesets `fixed`), but
 * the root `starbase` package isn't part of the workspace globs, so Changesets
 * never touches it — this script keeps it aligned.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const read = (path) => JSON.parse(readFileSync(path, "utf-8"))

const desktopPkgPath = join(repoRoot, "apps/desktop/package.json")
const rootPkgPath = join(repoRoot, "package.json")

const version = read(desktopPkgPath).version
const rootPkg = read(rootPkgPath)

if (rootPkg.version === version) {
  console.log(`root package.json already at ${version}`)
} else {
  rootPkg.version = version
  writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`)
  console.log(`synced root package.json → ${version}`)
}
