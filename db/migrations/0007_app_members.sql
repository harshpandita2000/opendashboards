CREATE TYPE "public"."app_member_access" AS ENUM('view', 'edit');--> statement-breakpoint
CREATE TABLE "app_members" (
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"access" "app_member_access" NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_members_app_id_user_id_pk" PRIMARY KEY("app_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app_members" ADD CONSTRAINT "app_members_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_members_user_id_idx" ON "app_members" USING btree ("user_id");