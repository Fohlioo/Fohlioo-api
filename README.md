# fohlioo-api

Event ingestion, auth exchange, and segmentation for Fohlioo. The Chrome
extension sends behavioural events; this API stores them, derives shopper
signals, classifies the four archetypes, and (after sign-in) attaches that
history to a real Supabase Auth user.

## Stack

- **Hono** — API server (TypeScript)
- **Supabase** — Postgres + Auth + pgvector
- **Zod** — request validation
- **Vitest** — unit tests
- **Railway** — hosting

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Supabase project** at supabase.com if you haven't already.

3. **Run the schema**
   - New project: paste `supabase/schema.sql` into the SQL editor and run it.
   - Existing project that already ran the original schema: run
     `supabase/migrations/002_auth_link.sql` instead (additive).

4. **Set environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in:
   - `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the **secret / service_role**
     key, not the publishable key)
   - `INGEST_API_KEY` — a long random secret (`openssl rand -hex 32`)
   - `PORT=8080` locally so this API does not collide with fohlioo-app on 3000

5. **Run locally**
   ```bash
   npm run dev
   ```
   Server starts on http://localhost:8080. Check `/health` to confirm it's up.

6. **Smoke-test ingestion**
   ```bash
   curl -X POST http://localhost:8080/api/v1/events \
     -H "Content-Type: application/json" \
     -H "x-fohlioo-key: $INGEST_API_KEY" \
     -d '{
       "extension_id": "test-install-123",
       "event_type": "page_view",
       "product_url": "https://www.cos.com/en-gb/example",
       "product_brand": "Cos",
       "product_price": 89,
       "currency": "GBP",
       "client_timestamp": 1721788800000
     }'
   ```
   Then:
   ```bash
   curl http://localhost:8080/api/v1/shoppers/test-install-123 \
     -H "x-fohlioo-key: $INGEST_API_KEY"
   ```
   You should see a shopper row (still `unclassified` until 10+ events with
   enough signals) and, after a brief async refresh, a `shopper_signals` row
   in Supabase.

7. **Smoke-test auth exchange** (until the webapp writes codes)
   Insert a row into `extension_auth_codes` for a real `auth.users` id,
   then:
   ```bash
   curl -X POST http://localhost:8080/api/v1/auth/exchange \
     -H "Content-Type: application/json" \
     -d '{"code":"test-code","extension_id":"test-install-123"}'
   ```
   Expect `access_token`, `refresh_token`, `user_id`, `expires_at`. That
   shopper row should now have `user_id` set. Events already logged for
   `test-install-123` stay on the same shopper.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | No | Liveness |
| `POST` | `/api/v1/auth/exchange` | One-time `code` in the body | Mint user tokens and link `extension_id` → `shoppers.user_id` |
| `POST` | `/api/v1/events` | `x-fohlioo-key` | Single event |
| `POST` | `/api/v1/events/batch` | `x-fohlioo-key` | Up to 100 events (preferred) |
| `GET` | `/api/v1/shoppers/:extension_id` | `x-fohlioo-key` | Profile + segment + signals |

After each successful ingest the server asynchronously recomputes
`shopper_signals` and reclassifies the shopper (Investment Dresser, Trend
Chaser, Quiet Minimalist, Brand Loyalist, or unclassified). Auth exchange
does not replace that pipeline — it only records who the shopper is.

## Tests

```bash
npm test
npm run test:watch
npm run typecheck
```

## Extension hand-off

See [docs/extension-integration.md](docs/extension-integration.md) for the
request contract: ingest key vs exchange, `extension_id`, event mapping,
and batch flush. The extension already calls these routes; set
`PLASMO_PUBLIC_API_URL=http://localhost:8080` and `PLASMO_API_KEY` to the
same ingest secret.

The webapp still needs `/auth/extension` and a route that inserts
`extension_auth_codes` before a real browser sign-in works end-to-end.

## Deploy to Railway

1. `railway login`
2. `railway init` (from this directory)
3. Add environment variables in the Railway dashboard (same as `.env`)
4. `railway up`
5. Railway gives you a public URL — that's `PLASMO_PUBLIC_API_URL`. Keep
   `INGEST_API_KEY` mirrored in the extension as a **non-public** env var
   used only by `background.ts`.

## What's next (out of scope here)

- fohlioo-app: `/auth/extension` + write `extension_auth_codes`
- AWIN catalogue + embeddings + curated feed
- Brand portal
