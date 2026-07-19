import type { EvalCase } from "./case.js"
import { defineCase, mentions } from "./case.js"

/**
 * The seeded corpus.
 *
 * Every case plants ONE defect a plan review should catch. They are deliberately
 * small: a large fixture measures how well a model can read a codebase, which is
 * a different question from whether an adversarial critic catches planning
 * mistakes a single model misses.
 *
 * Roughly a third are held out from prompt iteration. Tune against the rest.
 */

const ordering = defineCase({
  id: "ordering-backfill",
  defectClass: "ordering",
  brief:
    "Add a `tier` column to the accounts table and populate it for existing rows from the billing table. " +
    "Do the backfill first so no account is ever without a tier, then add the column.",
  fixture: {
    "db/schema.sql": "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL);\n",
    "db/README.md": "Migrations run in filename order. Every migration must be idempotent.\n"
  },
  defect: "the brief asks for the backfill before the column it writes to exists",
  detected: (c) => mentions(c, /order|before|after|sequenc|precede/i, /column|migration|backfill/i),
  heldOut: false
})

const hiddenCoupling = defineCase({
  id: "hidden-coupling-formatter",
  defectClass: "hidden-coupling",
  brief:
    "Change `formatMoney` in src/money.ts to always return two decimal places. " +
    "It currently trims trailing zeros and that looks untidy in the invoice header.",
  fixture: {
    "src/money.ts":
      "export const formatMoney = (cents: number): string =>\n" +
      "  (cents / 100).toString()\n",
    "src/invoice-header.tsx": "import { formatMoney } from './money.js'\n",
    "src/export-csv.ts":
      "import { formatMoney } from './money.js'\n" +
      "// The finance team's importer rejects a trailing zero, so this column must stay bare.\n" +
      "export const row = (cents: number) => `amount,${formatMoney(cents)}`\n",
    "src/export-csv.test.ts": "// asserts `amount,12.5` exactly\n"
  },
  defect: "formatMoney has a second consumer (the CSV export) whose importer rejects trailing zeros",
  detected: (c) => mentions(c, /csv|export|consumer|caller|other use/i),
  heldOut: false
})

const irreversibility = defineCase({
  id: "irreversible-drop",
  defectClass: "irreversibility",
  brief:
    "We renamed `user.username` to `user.handle` last release and the old column is unused. " +
    "Drop the `username` column to tidy the schema.",
  fixture: {
    "db/schema.sql":
      "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, handle TEXT);\n",
    "db/README.md": "Migrations are applied manually in production and are not automatically reversible.\n"
  },
  defect: "dropping a column is one-way and the plan names no backup or rollback",
  detected: (c) => mentions(c, /rollback|revert|irreversib|backup|restore|one-way|destructive|data loss/i),
  heldOut: false
})

const testGap = defineCase({
  id: "test-gap-retry",
  defectClass: "test-gap",
  brief:
    "Add retry-with-backoff to the webhook sender in src/webhook.ts so transient 5xx responses " +
    "are retried three times. Keep it simple.",
  fixture: {
    "src/webhook.ts":
      "export const send = async (url: string, body: string): Promise<Response> =>\n" +
      "  fetch(url, { method: 'POST', body })\n",
    "src/webhook.test.ts": "// covers the happy path only\n"
  },
  defect: "retry logic is the riskiest path and no step asks for a test of it",
  detected: (c) => mentions(c, /test|coverage|untested|assert/i),
  heldOut: true
})

const convention = defineCase({
  id: "convention-error-handling",
  defectClass: "convention",
  brief:
    "Add a `deleteAccount` function to src/accounts.ts. Throw an Error if the account is missing.",
  fixture: {
    "src/accounts.ts":
      "import { Effect } from 'effect'\n" +
      "import { AccountNotFound } from './errors.js'\n\n" +
      "// Every function in this file returns an Effect and fails with a tagged error.\n" +
      "export const getAccount = (id: string) =>\n" +
      "  Effect.fail(new AccountNotFound({ id }))\n",
    "src/errors.ts": "export class AccountNotFound extends Error {}\n"
  },
  defect: "the repo models failures as tagged Effects; the brief asks for a thrown Error",
  detected: (c) => mentions(c, /effect|convention|tagged|throw|idiom|existing pattern/i),
  heldOut: true
})

export const CORPUS: ReadonlyArray<EvalCase> = [
  ordering,
  hiddenCoupling,
  irreversibility,
  testGap,
  convention
]
