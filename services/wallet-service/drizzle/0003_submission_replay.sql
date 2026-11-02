CREATE TABLE "submission_replay" (
	"network" text NOT NULL,
	"address" text NOT NULL,
	"nonce" text NOT NULL,
	"expiration_ledger" bigint NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_replay_network_address_nonce_pk" PRIMARY KEY("network","address","nonce")
);
--> statement-breakpoint
CREATE INDEX "submission_replay_expiration_idx" ON "submission_replay" USING btree ("network","expiration_ledger");