/**
 * Apply pending SQL migrations to the database in DATABASE_URL.
 * Idempotent — Drizzle tracks applied migrations in __drizzle_migrations.
 *
 * Run with: npm run db:migrate
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
// Load the repo-root .env (the agent runner uses it too)
loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.error("DATABASE_URL is not set");
        process.exit(1);
    }
    const client = postgres(url, { max: 1 });
    const db = drizzle(client);
    console.log("Applying migrations…");
    await migrate(db, { migrationsFolder: "./lib/db/migrations" });
    console.log("Done.");
    await client.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
