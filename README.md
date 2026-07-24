# fohlioo-api

Event ingestion + segmentation backend for Fohlioo. Receives behavioural
signals from the Chrome extension, writes them to Supabase, derives shopper
signals, and classifies the four behavioural archetypes.

## Stack

- **Hono** — API server (TypeScript)
- **Supabase** — Postgres + pgvector, event storage
- **Zod** — request validation
- **Vitest** — unit tests for signals + classifier
- **Railway** — hosting

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Supabase project** at supabase.com if you haven't already.

3. **Run the schema**
   Open your Supabase project → SQL Editor → New query, paste in the
   contents of `supabase/schema.sql`, and run it.

4. **Set environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in:
   - `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from Project Settings → API
     (use the **service_role** key, not the anon key)
   - `INGEST_API_KEY` — a long random secret (`openssl rand -hex 32`). The
     extension sends this as `x-fohlioo-key` on every request.

5. **Run locally**
   ```bash
   npm run dev
   ```
   Server starts on http://localhost:3000. Check `/health` to confirm it's up.

6. **Smoke-test ingestion**
   ```bash
   curl -X POST http://localhost:3000/api/v1/events \
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
   curl http://localhost:3000/api/v1/shoppers/test-install-123 \
     -H "x-fohlioo-key: $INGEST_API_KEY"
   ```
   You should see a shopper row (still `unclassified` until 10+ events with
   enough signals) and, after a brief async refresh, a `shopper_signals` row
   in Supabase.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | No | Liveness |
| `POST` | `/api/v1/events` | `x-fohlioo-key` | Single event |
| `POST` | `/api/v1/events/batch` | `x-fohlioo-key` | Up to 100 events (preferred) |
| `GET` | `/api/v1/shoppers/:extension_id` | `x-fohlioo-key` | Profile + segment + signals |

After each successful ingest the server asynchronously recomputes
`shopper_signals` and reclassifies the shopper (Investment Dresser, Trend
Chaser, Quiet Minimalist, Brand Loyalist, or unclassified).

## Tests

```bash
npm test          # vitest once
npm run test:watch
npm run typecheck
```

Pure unit tests cover signal derivation (HHI, colour entropy, consideration
arc edge cases) and the rule-based classifier against the Notion worked
example.

## Extension hand-off

See [docs/extension-integration.md](docs/extension-integration.md) for the
exact request contract the extension's empty `lib/api.ts` should implement:
anonymous `extension_id`, event mapping, batch flush, and auth header.

## Deploy to Railway

1. `railway login`
2. `railway init` (from this directory)
3. Add environment variables in the Railway dashboard (same as `.env`)
4. `railway up`
5. Railway gives you a public URL — that's what goes into the extension's
   `PLASMO_PUBLIC_API_URL`. Keep `INGEST_API_KEY` mirrored in the extension
   as a **non-public** env var used only by `background.ts`.

## What's next (out of scope here)

- Wire the extension `lib/api.ts` + `background.ts` to this API
- AWIN catalogue ingestion + OpenAI embeddings + curated feed endpoint
- Supabase Auth (replace shared-secret ingest key with per-shopper tokens)
