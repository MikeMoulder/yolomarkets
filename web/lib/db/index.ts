/**
 * Singleton Postgres client. Reuses the connection across hot reloads in
 * dev so we don't run out of slots; in production each worker gets its own.
 *
 * Connection string lives in DATABASE_URL — see .env.example.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import * as schema from "./schema";

declare global {
    var __pgClient: ReturnType<typeof postgres> | undefined;
}

// In local dev, Next may only load web/.env.local. Fall back to repo-root
// .env so shared settings (like Neon DATABASE_URL) are visible here too.
if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
    const rootEnv = path.resolve(process.cwd(), "..", ".env");
    loadEnv({ path: rootEnv });
}

const url = process.env.DATABASE_URL;
const missingDbMessage =
    "DATABASE_URL is not set — configure your cloud Postgres (e.g. Neon) in .env.";

const client =
    url
        ? (globalThis.__pgClient ??
            postgres(url, {
                max: 4,
                idle_timeout: 30,
                prepare: false, // Next.js HMR + prepared statements don't mix
            }))
        : undefined;

if (client && process.env.NODE_ENV !== "production") {
    globalThis.__pgClient = client;
}

export const db = client
    ? drizzle(client, { schema })
    : (new Proxy(
          {},
          {
              get() {
                  throw new Error(missingDbMessage);
              },
          },
      ) as ReturnType<typeof drizzle>);
export { schema };
