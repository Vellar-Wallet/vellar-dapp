CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL
);
