CREATE TABLE "email_inboxes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_events" DROP CONSTRAINT "channel_events_channel";--> statement-breakpoint
ALTER TABLE "email_inboxes" ADD CONSTRAINT "email_inboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_inboxes_due" ON "email_inboxes" USING btree ("next_poll_at");--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_channel" CHECK ("channel_events"."channel" IN ('whatsapp','elevenlabs','email'));