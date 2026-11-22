CREATE TABLE "app_guests" (
	"app_id" uuid NOT NULL,
	"email" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_guests_app_id_email_pk" PRIMARY KEY("app_id","email")
);
--> statement-breakpoint
ALTER TABLE "app_guests" ADD CONSTRAINT "app_guests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_guests_email_idx" ON "app_guests" USING btree ("email");