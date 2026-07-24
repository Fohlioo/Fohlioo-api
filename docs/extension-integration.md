# Extension ↔ API integration contract

This document is the hand-off for wiring the extension's empty `lib/api.ts`
to this backend. Extension-side changes live in
[Fohlioo-extension](https://github.com/Fohlioo/Fohlioo-extension); this repo
only defines the contract.

## Auth

Every `/api/v1/*` request must include:

```
x-fohlioo-key: <INGEST_API_KEY>
```

The key is a shared secret. Store it only in the extension **background
worker** (never in a content script, never in `PLASMO_PUBLIC_*` env vars that
get bundled into page context). Missing or wrong key → `401`.

## Anonymous shopper identity

The API keys shoppers by `extension_id`, not by email/auth.

On first run, the extension should generate a UUID and persist it in
`chrome.storage.local`:

```ts
async function getOrCreateExtensionId(): Promise<string> {
  const { extensionId } = await chrome.storage.local.get("extensionId")
  if (typeof extensionId === "string" && extensionId.length > 0) {
    return extensionId
  }
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ extensionId: id })
  return id
}
```

Send that same value on every event. The API upserts a `shoppers` row on
first sight and reuses it forever.

## Endpoints

Base URL: `process.env.PLASMO_PUBLIC_API_URL` (e.g. `http://localhost:3000`
in development, Railway URL in production).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/events` | Single event |
| `POST` | `/api/v1/events/batch` | Up to 100 events (preferred) |
| `GET`  | `/api/v1/shoppers/:extension_id` | Profile + segment + signals |
| `GET`  | `/health` | Liveness (no auth) |

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

Batch:

```ts
{ events: IncomingEvent[] } // 1–100
```

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

1. Queue events in memory (or `chrome.storage.local`) after each
   `applySessionUpdate`.
2. Flush via `POST /api/v1/events/batch` every few seconds, on
   `visibilitychange` → hidden, and on extension suspend if possible.
3. On network failure: keep the queue and retry. Never block the popup or
   content script on API errors.

Example shape for `lib/api.ts`:

```ts
const API_URL = process.env.PLASMO_PUBLIC_API_URL
const API_KEY = process.env.PLASMO_API_KEY // background-only, not PLASMO_PUBLIC_

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
`unclassified` with confidence `0` — do not show that as a real style mix
in the popup.

## What happens server-side after ingest

1. Upsert shopper(s) by `extension_id`
2. Insert all events in one round trip
3. Increment `shoppers.event_count` / set `last_active_at`
4. Asynchronously recompute `shopper_signals` and reclassify the segment
   (never blocks the HTTP response)
