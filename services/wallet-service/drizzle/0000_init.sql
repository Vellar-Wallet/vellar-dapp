CREATE TABLE "activity_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"network" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"key_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"network" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallets_key_id_network_pk" PRIMARY KEY("key_id","network")
);
