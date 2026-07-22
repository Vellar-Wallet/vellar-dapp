CREATE TABLE "verification_records" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_records_contract_idx" ON "verification_records" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "verification_records_status_idx" ON "verification_records" USING btree ("status");