CREATE TYPE "public"."model_provider_kind" AS ENUM('azure_openai');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "model_provider_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"secret" jsonb NOT NULL,
	"credential_hint" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "connection_status" NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "org_invites_not_owner" CHECK ("org_invites"."role" <> 'owner')
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"personal_for" text,
	"openui_user_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_openui_user_id_unique" UNIQUE("openui_user_id")
);
--> statement-breakpoint
DROP INDEX "data_connections_user_demo_idx";--> statement-breakpoint
ALTER TABLE "app_threads" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "data_connections" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sign_ins" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_providers_org_id_idx" ON "model_providers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_default_idx" ON "model_providers" USING btree ("org_id") WHERE "model_providers"."is_default";--> statement-breakpoint
CREATE INDEX "org_invites_org_id_idx" ON "org_invites" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invites_open_idx" ON "org_invites" USING btree ("org_id","email") WHERE "org_invites"."accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_members_user_id_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_personal_for_idx" ON "orgs" USING btree ("personal_for");--> statement-breakpoint
-- Organisations. Every existing user gets a personal organisation that owns
-- what they had, and is its owner. OpenUI Cloud identity stays the user's id
-- for these, so their dashboards and threads in Cloud stay readable.
CREATE FUNCTION od_personal_org(p_user_id text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_org uuid;
BEGIN
  SELECT id INTO v_org FROM orgs WHERE personal_for = p_user_id;
  IF v_org IS NULL THEN
    INSERT INTO orgs (name, personal_for, openui_user_id, created_by)
      VALUES ('Personal', p_user_id, p_user_id, p_user_id)
      ON CONFLICT (personal_for) DO NOTHING
      RETURNING id INTO v_org;
    IF v_org IS NULL THEN
      SELECT id INTO v_org FROM orgs WHERE personal_for = p_user_id;
    END IF;
    INSERT INTO org_members (org_id, user_id, email, role) VALUES (v_org, p_user_id, '', 'owner') ON CONFLICT DO NOTHING;
  END IF;
  RETURN v_org;
END $$;--> statement-breakpoint
-- Rollout safety: the previous deployment keeps inserting rows without org_id
-- until this one is live. Such a row goes to its creator's personal
-- organisation (dashboards and threads to their app's). Drop in a later release.
CREATE FUNCTION od_fill_org_id_from_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS NULL THEN NEW.org_id := od_personal_org(NEW.user_id); END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION od_fill_org_id_from_app() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS NULL THEN SELECT org_id INTO NEW.org_id FROM apps WHERE id = NEW.app_id; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
UPDATE "data_connections" SET "org_id" = od_personal_org("user_id");--> statement-breakpoint
UPDATE "apps" SET "org_id" = od_personal_org("user_id");--> statement-breakpoint
UPDATE "mcp_oauth_sign_ins" SET "org_id" = od_personal_org("user_id");--> statement-breakpoint
UPDATE "dashboards" SET "org_id" = "apps"."org_id" FROM "apps" WHERE "apps"."id" = "dashboards"."app_id";--> statement-breakpoint
UPDATE "app_threads" SET "org_id" = "apps"."org_id" FROM "apps" WHERE "apps"."id" = "app_threads"."app_id";--> statement-breakpoint
ALTER TABLE "app_threads" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "data_connections" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sign_ins" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
CREATE TRIGGER "data_connections_fill_org_id" BEFORE INSERT ON "data_connections" FOR EACH ROW EXECUTE FUNCTION od_fill_org_id_from_user();--> statement-breakpoint
CREATE TRIGGER "apps_fill_org_id" BEFORE INSERT ON "apps" FOR EACH ROW EXECUTE FUNCTION od_fill_org_id_from_user();--> statement-breakpoint
CREATE TRIGGER "mcp_oauth_sign_ins_fill_org_id" BEFORE INSERT ON "mcp_oauth_sign_ins" FOR EACH ROW EXECUTE FUNCTION od_fill_org_id_from_user();--> statement-breakpoint
CREATE TRIGGER "dashboards_fill_org_id" BEFORE INSERT ON "dashboards" FOR EACH ROW EXECUTE FUNCTION od_fill_org_id_from_app();--> statement-breakpoint
CREATE TRIGGER "app_threads_fill_org_id" BEFORE INSERT ON "app_threads" FOR EACH ROW EXECUTE FUNCTION od_fill_org_id_from_app();--> statement-breakpoint
ALTER TABLE "app_threads" ADD CONSTRAINT "app_threads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sign_ins" ADD CONSTRAINT "mcp_oauth_sign_ins_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_org_id_idx" ON "apps" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "dashboards_org_id_idx" ON "dashboards" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "data_connections_org_id_idx" ON "data_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_connections_org_demo_idx" ON "data_connections" USING btree ("org_id","demo_dataset");