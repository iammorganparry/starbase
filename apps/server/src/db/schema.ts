/**
 * BetterAuth's core Drizzle schema (Postgres). Table + column names match what
 * `betterAuth` + `drizzleAdapter` expect out of the box, so no field mapping is
 * needed. Downstream product tables (billing, subscriptions) will reference
 * `user.id` — this is the anchor the paid-user work hangs off.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique
} from "drizzle-orm/pg-core"

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull()
})

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // The org the session is currently acting in (BetterAuth organization plugin).
  activeOrganizationId: text("active_organization_id")
})

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull()
})

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date())
})

// ── Organization plugin (teams) ──────────────────────────────────────────────
// Table + column names match what the BetterAuth `organization` plugin expects.
// Teams/dynamic-roles are disabled, so only these three tables are needed.

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull()
})

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  createdAt: timestamp("created_at").notNull()
})

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
})

/**
 * A scored outcome contributed by one member, scoped to an organisation and a
 * repository.
 *
 * Scoped by organisation because learnings pool across a TEAM working on the
 * same repositories — evidence from teammates on one repo is directly
 * comparable, unlike evidence pooled across strangers' unrelated codebases.
 *
 * `repoKey` is a hash of the repository's root commit, never its name: it is
 * identical across every clone and computable only by someone who already has
 * the repo, so a team pools evidence without this server ever learning what
 * their repositories are called.
 *
 * `userId` exists for abuse control and rate limiting ONLY. It is never exposed
 * in an aggregate: how a MODEL performed is the question, and attributing a bad
 * outcome to a named teammate would poison the feature inside a team.
 *
 * There is deliberately no free-text column. The desktop's `Outcome` schema is
 * closed by construction and this mirrors it, so a leak would take a migration
 * rather than an oversight.
 */
export const repoModelOutcome = pgTable(
  "repo_model_outcome",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Hashed repository identity — see `repo-key.ts` in @starbase/core. */
    repoKey: text("repo_key").notNull(),
    taskKind: text("task_kind").notNull(),
    cli: text("cli").notNull(),
    vendor: text("vendor").notNull(),
    /** The RESOLVED model id, never an alias. */
    model: text("model").notNull(),
    findingsCritical: integer("findings_critical").notNull(),
    findingsMajor: integer("findings_major").notNull(),
    findingsMinor: integer("findings_minor").notNull(),
    findingsNit: integer("findings_nit").notNull(),
    ciPassed: boolean("ci_passed"),
    merged: boolean("merged"),
    filesReverted: integer("files_reverted").notNull(),
    planRevisions: integer("plan_revisions").notNull(),
    sizeBucket: text("size_bucket").notNull(),
    score: doublePrecision("score").notNull(),
    /** Day precision only — a timestamp plus commit cadence fingerprints a person. */
    occurredOn: text("occurred_on").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull()
  },
  (table) => [
    // The read path is always (org, repo, kind); the unique key also makes
    // contribution idempotent, so a client retrying a failed sync cannot
    // double-count its own outcome.
    index("repo_model_outcome_lookup").on(table.organizationId, table.repoKey, table.taskKind),
    unique("repo_model_outcome_identity").on(table.organizationId, table.userId, table.id)
  ]
)

export const schema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation
}
