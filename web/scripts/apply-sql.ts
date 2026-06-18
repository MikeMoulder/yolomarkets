/**
 * One-off: apply a single raw SQL migration file directly against DATABASE_URL.
 * Used because this DB is not managed by drizzle migrate() (no
 * __drizzle_migrations table) — see CLAUDE.md. The target SQL must be
 * idempotent (IF NOT EXISTS / ON CONFLICT).
 *
 *   npx tsx scripts/apply-sql.ts lib/db/migrations/0007_agent_wallets.sql
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { readFileSync } from "node:fs";
loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

import postgres from "postgres";

async function main() {
    const url = process.env.DATABASE_URL;
    const file = process.argv[2];
    if (!url) throw new Error("DATABASE_URL is not set");
    if (!file) throw new Error("usage: apply-sql.ts <path-to.sql>");

    const sqlText = readFileSync(path.resolve(process.cwd(), file), "utf8");
    const client = postgres(url, { max: 1 });
    console.log(`Applying ${file} …`);
    await client.unsafe(sqlText);
    console.log("Done.");
    await client.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
