# Extension ↔ API integration contract

How the Chrome extension talks to this API. Capture still lives in the
extension; this backend stores events, derives signals, and (now) attaches
an anonymous install to a signed-in user.

Locally the API listens on **8080** so it does not collide with fohlioo-app
on 3000. Set `PLASMO_PUBLIC_API_URL=http://localhost:8080`.

## Auth: two different credentials

| Route | Credential | Why |
|-------|------------|-----|
| `POST /api/v1/events` and `/batch` | `x-fohlioo-key: <INGEST_API_KEY>` | Stops strangers flooding the event log. Anonymous browsing still works — the shopper is identified by `extension_id`, not a login. |
| `GET /api/v1/shoppers/:extension_id` | same ingest key | Same |
| `POST /api/v1/auth/exchange` | **none** (JSON `{ code, extension_id }` only) | The one-time code *is* the secret. The extension does not send the ingest key here. |
| `GET /health` | none | Liveness |

Optional on event routes: `Authorization: Bearer <access_token>` after sign-in. The API does not require it for ingest. CORS allows that header.

Store `PLASMO_API_KEY` only in the extension **background worker** (never `PLASMO_PUBLIC_*`).

## Anonymous shopper identity

On first run the extension generates a UUID and keeps it in
`chrome.storage.local` under `extension_id`. Sign-in and sign-out must
never regenerate it.

Every event includes that id. The API upserts a `shoppers` row and a
`shopper_installs` row. After the user signs in, `shoppers.user_id` is set
and browsing history stays attached to the same person.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/auth/exchange` | One-time code → Supabase tokens + shopper merge |
| `POST` | `/api/v1/events` | Single event |
| `POST` | `/api/v1/events/batch` | Up to 100 events (preferred) |
| `GET`  | `/api/v1/shoppers/:extension_id` | Profile + segment + signals |
| `GET`  | `/health` | Liveness (no auth) |

Signals already recompute after every successful ingest. Auth does not
recompute them except when a second install is merged onto an existing
account.

## Auth exchange

The webapp (not this repo) creates a row in `extension_auth_codes` after
login. The extension then:

```
POST /api/v1/auth/exchange
{ "code": "<one-time>", "extension_id": "<uuid>" }
```

Success (this shape is what the extension already parses):

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "user_id": "...",
  "expires_at": 1234567890000
}
```

`expires_at` is unix milliseconds. Invalid / used / expired / mismatched
codes return `401`. Token mint failure returns `500` and never invents JWTs.

Until the webapp writes codes, you can smoke-test by inserting a row in
the SQL editor (use a real `auth.users` id, expiry ~60s from now) and
curling the endpoint.

## Event body

```ts
type IncomingEvent = {
  extension_id: string
  event_type:
    | "page_view"
    | "wishlist_add"
    | "wishlist_remove"
    | "add_to_cart"
    | "remove_from_cart"
    | "dwell_milestone"
    | "scroll_milestone"
    | "details_section_view"
    | "material_section_view"
    | "size_guide_view"
    | "review_section_view"
    | "size_selected"
    | "colour_selected"
    | "cart_abandon"
    | "purchase_confirmed"
    | "return_initiated"
  product_url?: string
  product_name?: string
  product_brand?: string
  product_price?: number
  original_price?: number
  currency?: string          // ISO 4217, e.g. "GBP"
  category?: string
  colour?: string
  dwell_ms?: number          // dwell_milestone
  scroll_pct?: number        // scroll_milestone, 0–100
  client_timestamp?: number  // ms since epoch — maps to events.occurred_at
  payload?: Record<string, unknown>
}
```

Batch: `{ events: IncomingEvent[] }` (1–100).

## Mapping from extension messages

Route through `background.ts` only — never call the API from a content script.

| Extension message | `event_type` | Notes |
|-------------------|--------------|-------|
| `PRODUCT_CAPTURED` (with `recordVisit`) | `page_view` | Map `ProductData` fields → `product_*` / `colour` / `category` |
| `WISHLIST_ADD` / `WISHLIST_REMOVE` | `wishlist_add` / `wishlist_remove` | |
| `ADD_TO_CART` / `REMOVE_FROM_CART` | `add_to_cart` / `remove_from_cart` | |
| `DWELL_MILESTONE` | `dwell_milestone` | Set `dwell_ms` from `milestoneMs` |
| `SCROLL_MILESTONE` | `scroll_milestone` | Set `scroll_pct` from `milestonePct` |
| `SECTION_ENGAGEMENT` | `details_section_view` / `material_section_view` / `size_guide_view` / `review_section_view` | Map `section` the same way `background.ts` maps to session feed types |

Always send `client_timestamp: Date.now()` so signal windows stay accurate
if batches flush late.

## Flush strategy

1. Queue events in `chrome.storage.local` after each session update.
2. Flush via `POST /api/v1/events/batch` every few seconds and on suspend.
3. On network failure: keep the queue and retry. Never block the popup.

```ts
const API_URL = process.env.PLASMO_PUBLIC_API_URL
const API_KEY = process.env.PLASMO_API_KEY // background-only

export async function flushEvents(events: IncomingEvent[]): Promise<void> {
  if (!API_URL || events.length === 0) return
  const res = await fetch(`${API_URL}/api/v1/events/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fohlioo-key": API_KEY!,
    },
    body: JSON.stringify({ events }),
  })
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`)
}
```

## Reading the shopper profile

```ts
GET /api/v1/shoppers/:extension_id
→ {
  ok: true,
  shopper: {
    extension_id, email, segment, segment_confidence,
    event_count, last_active_at, created_at
  },
  signals: { /* shopper_signals row, or null if none yet */ }
}
```

`segment` is one of `investment_dresser | trend_chaser | quiet_minimalist |
brand_loyalist | unclassified`. Below 10 events the shopper stays
`unclassified` with confidence `0`.

## What happens server-side after ingest

1. Resolve shopper via `shopper_installs`, or create one
2. Insert events
3. Increment `shoppers.event_count` / set `last_active_at`
4. Asynchronously recompute `shopper_signals` and reclassify the segment
