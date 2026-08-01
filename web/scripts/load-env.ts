/**
 * Side-effect module: load the repo's env files.
 *
 * Import this FIRST, before any `../lib/*` import, in every standalone script:
 *
 *   import "./load-env";
 *   import { something } from "../lib/db";
 *
 * Why it can't just be a `loadEnv()` call at the top of the script: tsx/esbuild
 * hoists `require` calls above the statements between them, so a `loadEnv()`
 * written after the imports — or even between them — runs *after* the imported
 * modules have already been evaluated. `lib/db` captures DATABASE_URL at module
 * scope, and its root-.env fallback is skipped when NODE_ENV=production (which
 * pm2 sets), so a late load leaves the DB client permanently unconfigured.
 * Import order IS preserved, so putting the load inside its own module and
 * importing it first is what actually works.
 *
 * Root `.env` wins over `web/.env.local` — the root file holds the operational
 * keys (notably the factory-admin DEPLOYER_PRIVATE_KEY).
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });
loadEnv({ path: path.resolve(__dirname, "..", ".env.local"), override: false });
