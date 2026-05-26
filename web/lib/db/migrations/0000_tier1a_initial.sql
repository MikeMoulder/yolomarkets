CREATE TABLE "agent_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"market" text NOT NULL,
	"question" text NOT NULL,
	"category" text NOT NULL,
	"market_prob" numeric NOT NULL,
	"polymarket_prob" numeric,
	"polymarket_slug" text,
	"ai_prob" numeric NOT NULL,
	"ai_confidence" numeric NOT NULL,
	"edge_pts" numeric NOT NULL,
	"kelly_fraction" numeric NOT NULL,
	"bankroll_usdc" numeric NOT NULL,
	"action" text NOT NULL,
	"pass_reason" text,
	"shares" bigint NOT NULL,
	"cost_usdc" numeric NOT NULL,
	"max_cost_usdc" numeric NOT NULL,
	"tx_hash" text,
	"paper" boolean NOT NULL,
	"reasoning" text NOT NULL,
	"watch_for" jsonb NOT NULL,
	"time_sensitivity" text NOT NULL,
	"user_addr" text,
	"agent_addr" text
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"user_addr" text PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"cadence_minutes" integer NOT NULL,
	"kelly_mult" numeric NOT NULL,
	"edge_threshold" numeric NOT NULL,
	"min_confidence" numeric NOT NULL,
	"signals" jsonb NOT NULL,
	"markets_mode" text NOT NULL,
	"categories" jsonb NOT NULL,
	"watchlist" jsonb NOT NULL,
	"budget_total" numeric NOT NULL,
	"budget_per_market" numeric NOT NULL,
	"budget_per_day" numeric NOT NULL,
	"agent_address" text,
	"session_key_address" text,
	"session_valid_until" bigint,
	"session_total_cap" numeric,
	"session_per_call_cap" numeric,
	"active" boolean DEFAULT true NOT NULL,
	"paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_keys" (
	"user_addr" text PRIMARY KEY NOT NULL,
	"public_addr" text NOT NULL,
	"encrypted_pk" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_decisions_user_ts" ON "agent_decisions" USING btree ("user_addr","ts");--> statement-breakpoint
CREATE INDEX "idx_agent_decisions_ts" ON "agent_decisions" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_agent_decisions_market" ON "agent_decisions" USING btree ("market");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_keys_public_addr" ON "agent_session_keys" USING btree ("public_addr");