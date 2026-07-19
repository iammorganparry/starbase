CREATE TABLE "repo_model_outcome" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"repo_key" text NOT NULL,
	"task_kind" text NOT NULL,
	"cli" text NOT NULL,
	"vendor" text NOT NULL,
	"model" text NOT NULL,
	"findings_critical" integer NOT NULL,
	"findings_major" integer NOT NULL,
	"findings_minor" integer NOT NULL,
	"findings_nit" integer NOT NULL,
	"ci_passed" boolean,
	"merged" boolean,
	"files_reverted" integer NOT NULL,
	"plan_revisions" integer NOT NULL,
	"size_bucket" text NOT NULL,
	"score" double precision NOT NULL,
	"occurred_on" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "repo_model_outcome_identity" UNIQUE("organization_id","user_id","id")
);
--> statement-breakpoint
ALTER TABLE "repo_model_outcome" ADD CONSTRAINT "repo_model_outcome_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_model_outcome" ADD CONSTRAINT "repo_model_outcome_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_model_outcome_lookup" ON "repo_model_outcome" USING btree ("organization_id","repo_key","task_kind");