CREATE TABLE "marketplace_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_address" text NOT NULL,
	"resource_url" text NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"price_atomic" bigint NOT NULL,
	"asset" text NOT NULL,
	"scheme" varchar(20) DEFAULT 'exact' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"first_settled_at" timestamp with time zone,
	"total_settlements" bigint DEFAULT 0 NOT NULL,
	"total_revenue" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "marketplace_listings_resource_url_unique" UNIQUE("resource_url")
);
--> statement-breakpoint
CREATE TABLE "marketplace_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text,
	"tx_hash" varchar(64) NOT NULL,
	"buyer_address" text,
	"amount_atomic" bigint NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"ledger" integer NOT NULL,
	CONSTRAINT "marketplace_settlements_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "marketplace_settlements" ADD CONSTRAINT "marketplace_settlements_listing_id_marketplace_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."marketplace_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_listings_seller_address_idx" ON "marketplace_listings" USING btree ("seller_address");--> statement-breakpoint
CREATE INDEX "marketplace_listings_status_idx" ON "marketplace_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "marketplace_listings_resource_url_idx" ON "marketplace_listings" USING btree ("resource_url");--> statement-breakpoint
CREATE INDEX "marketplace_nonces_address_idx" ON "marketplace_nonces" USING btree ("address");--> statement-breakpoint
CREATE INDEX "marketplace_nonces_expires_at_idx" ON "marketplace_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "marketplace_settlements_listing_id_idx" ON "marketplace_settlements" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "marketplace_settlements_settled_at_idx" ON "marketplace_settlements" USING btree ("settled_at");