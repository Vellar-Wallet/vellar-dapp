CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"line" text NOT NULL,
	"network" text NOT NULL,
	"stroops" bigint NOT NULL,
	"count" integer NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spend_ledger_line_network_at_idx" ON "spend_ledger" USING btree ("line","network","at");
