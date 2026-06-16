# Circle setup — User-Controlled Wallets + Gas Station

This document walks through the Circle Console setup the YOLO Markets web
app needs before the Circle Wallets + Gas Station integration can light
up end-to-end. All the code is already in the repo; only the keys + a few
Console toggles are missing.

**Time: ~15 minutes.** Most of it is waiting for entity-secret rotation
to confirm in the Console UI.

> **Console UI note (2026):** Circle reorganised the Console in early 2026.
> The "Configurator → Entity Secret" paste-in-Console flow no longer
> exists — the entity secret is generated and registered programmatically.
> The doc below reflects the current UI.

## 1. Sign up + get an API key

1. Sign up / sign in at [console.circle.com](https://console.circle.com).
2. Sandbox mode is the default for new accounts — no toggle needed.
3. **Sidebar → API and client keys → Generate Key.** Use a **Test** key
   (free); production keys cost money per wallet provisioned.
4. Copy into `.env` as `CIRCLE_API_KEY=TEST_API_KEY:…`.

## 2. Find your App ID

The App ID is buried inside the Wallets product, not the top-level API
page. Two paths to find it:

**Via Console:**

> Sidebar → **Wallets: User-Controlled** → **Configurator** → "App ID" is
> shown on the configurator page.

**Via API (faster):**

```sh
curl -H "Authorization: Bearer $CIRCLE_API_KEY" \
     https://api.circle.com/v1/w3s/config/entity | jq .data.appId
```

Copy the value into `.env` twice (server-side and `NEXT_PUBLIC_*` mirror):

```
CIRCLE_APP_ID=<app id>
NEXT_PUBLIC_CIRCLE_APP_ID=<same value>
```

`NEXT_PUBLIC_CIRCLE_APP_ID` must be present at **build time** because
Next.js inlines `NEXT_PUBLIC_*` constants into the client bundle. Add
both before `npm run build`.

## 3. Generate + register the entity secret

The entity secret is a 32-byte secret that authorises state-changing
Circle calls (wallet creation, transaction execution). The current flow:
generate locally → encrypt with Circle's project public key → POST to
register → Circle returns a recovery file → save it.

Use the one-shot script in this repo (no SDK install required):

```sh
# From repo root, requires CIRCLE_API_KEY already in .env
npx tsx scripts/register-circle-entity-secret.ts
```

The script will:

1. Generate 32 bytes of randomness locally.
2. Fetch your project's RSA public key from
   `GET /v1/w3s/config/entity/publicKey`.
3. RSA-OAEP-SHA256-encrypt the secret with that key.
4. POST the ciphertext to `/v1/w3s/config/entity/entitySecret`.
5. Save the recovery file Circle returns to
   `scripts/recovery_<timestamp>.dat`.
6. Print the 64-hex-char secret — paste it into `.env` as
   `CIRCLE_ENTITY_SECRET=`.

**Store the recovery file safely** (1Password / Bitwarden / iCloud).
The file is the only path back if you lose the secret; the secret
itself can't be retrieved from Console once registered. The
`.gitignore` already excludes `scripts/recovery_*.dat`.

## 4. Confirm Arc Testnet support

Arc Testnet is in Circle's blockchain catalog (they co-sponsored this
hackathon). Our code defaults to `CIRCLE_BLOCKCHAIN=ARC-TESTNET` — if a
later Console docs page uses a different slug, override in `.env`.

To confirm: a freshly-created wallet via `/api/circle/init` returns a
wallet object whose `blockchain` field matches the slug Circle uses;
align `CIRCLE_BLOCKCHAIN` to that value.

## 5. Enable Gas Station

Once Wallets work, Gas Station sponsors USDC gas on your behalf so
new users can place a bet without holding any native USDC for fees.

1. Console → **Gas Station** → enable.
2. Select **Arc Testnet** as the supported chain.
3. Deposit some test USDC into the Gas Station treasury (Console will
   walk you through this; for the hackathon, $5 is plenty).
4. Add a policy rule: "sponsor all transactions from any wallet in
   this project". This is the most permissive policy; tighten later.
5. The policy ID is shown in the Console under the policy's row — copy
   it to `.env` as `CIRCLE_GAS_STATION_POLICY=…` (optional; we read it
   when constructing transactions).

## 6. Create a Developer Wallet Set

Autonomous agent wallets use Circle **Developer-Controlled Wallets**. Circle
requires every `/developer/wallets` creation request to include a wallet set.

1. Console → **Wallets: Developer-Controlled** → **Wallet Sets**.
2. Create or open the wallet set for this environment.
3. Copy its ID to `.env` as `CIRCLE_WALLET_SET_ID=…`.

If this is missing, Circle returns:

```text
'walletSetId' field may not be empty
```

## 7. Apply the env vars

Your `.env` should now include:

```
CIRCLE_API_KEY=TEST_API_KEY:…
CIRCLE_ENTITY_SECRET=<64 hex chars>
CIRCLE_APP_ID=…
CIRCLE_BLOCKCHAIN=ARC-TESTNET           # only if different from default
CIRCLE_WALLET_SET_ID=…                  # Developer Wallets → Wallet Sets
CIRCLE_GAS_STATION_POLICY=…             # optional
NEXT_PUBLIC_CIRCLE_APP_ID=…             # same as CIRCLE_APP_ID; needed by Web SDK
```

`NEXT_PUBLIC_CIRCLE_APP_ID` must mirror `CIRCLE_APP_ID` because the
Circle Web SDK (used client-side for PIN entry) reads it from
`process.env.NEXT_PUBLIC_*`.

## 8. Verify

With Postgres + the migrations applied (`cd web && npm run db:migrate`)
and the env vars set:

```sh
# Sanity test the server side — should return a 200 with a fresh
# circleUserId, userToken, encryptionKey, and challengeId.
curl -X POST http://localhost:3000/api/circle/init \
    -H 'content-type: application/json' \
    -d '{"email":"you@example.com"}' | jq
```

A `200` with all four fields means the server-side integration is
working. A `503` with `needsSetup: true` means an env var is missing
or wrong; check the `detail` field for which one.

## 9. Client UI — what's still TODO

The server-side path is fully scaffolded. The client UI that drives the
Web SDK PIN entry is **not** in the repo yet — it needs the Circle keys
to be working to verify, and there are policy decisions (host the PIN
modal where? launch from the landing-page CTA or from the agent setup
wizard?) better made together with you.

The remaining client work, in order of effort:

1. `npm install @circle-fin/w3s-pw-web-sdk` in `web/`.
2. A new `web/components/circle-signin.tsx` client component that:
   a. Renders an email input → button "Sign in with email".
   b. On click, `POST /api/circle/init` with the email.
   c. With the returned userToken + encryptionKey + challengeId,
      calls the Web SDK's `execute(challengeId, ...)` to drive PIN UX.
   d. On success, `POST /api/circle/wallet` to retrieve the address.
   e. Mirror the wagmi connect flow — surface the new address via a
      shared "useUserAddress()" hook so the rest of the app (agent
      profile, market trades) just sees an address and doesn't care
      whether the user came in via Circle or MetaMask.
3. A "Sign in with email" CTA on the landing page that opens the
   modal. The existing `WalletButton` keeps the MetaMask path for
   crypto-native users.

## Notes

- The agent's per-user execution (`AgentAccount.execute` via session key)
  works the same regardless of how the user signed up. Circle wallets
  own the AgentAccount the same way an injected wallet would.
- Gas Station fee sponsorship lives at the *transaction* layer, so it
  applies cleanly to both manual bets and agent-driven trades.
- If you don't get to the client UI before submission, document the
  setup completed (Console project, entity secret registered, Gas
  Station enabled) in `traction.md` so judges credit the Circle work
  even without a clickable demo.
