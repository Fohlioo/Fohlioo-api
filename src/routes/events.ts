import { Hono } from "hono";
import { ZodError } from "zod";
import { supabase } from "../lib/supabase";
import { eventSchema, eventBatchSchema, type IncomingEvent } from "../lib/schema";
import { refreshShopperIntelligence } from "../lib/segments";

const events = new Hono();

// Reject client timestamps that are obviously wrong (clock skew, bad data)
// rather than writing garbage into occurred_at.
const OCCURRED_AT_MIN_MS = Date.parse("2025-01-01T00:00:00Z");
const OCCURRED_AT_MAX_SKEW_MS = 5 * 60 * 1000;

function resolveOccurredAt(clientTimestamp: number | undefined): string {
  if (
    typeof clientTimestamp === "number" &&
    Number.isFinite(clientTimestamp) &&
    clientTimestamp >= OCCURRED_AT_MIN_MS &&
    clientTimestamp <= Date.now() + OCCURRED_AT_MAX_SKEW_MS
  ) {
    return new Date(clientTimestamp).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Resolves each unique extension_id in the batch to its internal shopper
 * uuid in a single upsert round trip. Upsert on extension_id keeps this
 * idempotent — repeated calls for the same install return the same shopper.
 */
async function resolveShopperIds(
  extensionIds: string[]
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("shoppers")
    .upsert(
      extensionIds.map((extension_id) => ({ extension_id })),
      { onConflict: "extension_id" }
    )
    .select("id, extension_id");

  if (error || !data) {
    throw new Error(`Failed to resolve shoppers: ${error?.message}`);
  }

  return new Map(data.map((row) => [row.extension_id as string, row.id as string]));
}

function toEventRow(shopperId: string, event: IncomingEvent) {
  const payload: Record<string, unknown> = { ...event.payload };
  if (event.dwell_ms !== undefined) payload.dwell_ms = event.dwell_ms;
  if (event.scroll_pct !== undefined) payload.scroll_pct = event.scroll_pct;

  return {
    shopper_id: shopperId,
    event_type: event.event_type,
    product_url: event.product_url ?? null,
    product_name: event.product_name ?? null,
    product_brand: event.product_brand ?? null,
    product_price: event.product_price ?? null,
    original_price: event.original_price ?? null,
    currency: event.currency ?? null,
    category: event.category ?? null,
    colour: event.colour ?? null,
    occurred_at: resolveOccurredAt(event.client_timestamp),
    payload: Object.keys(payload).length > 0 ? payload : null,
  };
}

/**
 * Shared ingest path for both endpoints: resolve shoppers once, insert all
 * rows in one round trip, bump activity counters, then recompute signals +
 * segment per shopper asynchronously (never blocks the response).
 */
async function ingestEvents(incoming: IncomingEvent[]): Promise<number> {
  const extensionIds = [...new Set(incoming.map((e) => e.extension_id))];
  const shopperIds = await resolveShopperIds(extensionIds);

  const rows = incoming.map((event) =>
    toEventRow(shopperIds.get(event.extension_id)!, event)
  );

  const { error } = await supabase.from("events").insert(rows);
  if (error) {
    throw new Error(`Failed to insert events: ${error.message}`);
  }

  const countByShopper = new Map<string, number>();
  for (const row of rows) {
    countByShopper.set(
      row.shopper_id,
      (countByShopper.get(row.shopper_id) ?? 0) + 1
    );
  }

  await Promise.all(
    [...countByShopper.entries()].map(([shopperId, count]) =>
      supabase.rpc("increment_shopper_activity", {
        p_shopper_id: shopperId,
        p_count: count,
      })
    )
  );

  // Fire-and-forget: segmentation must never delay or fail the ingest.
  for (const shopperId of countByShopper.keys()) {
    refreshShopperIntelligence(shopperId).catch((err) =>
      console.error(`[intelligence] refresh failed for shopper=${shopperId}`, err)
    );
  }

  return incoming.length;
}

// POST /api/v1/events — single event
events.post("/", async (c) => {
  try {
    const body = eventSchema.parse(await c.req.json());
    await ingestEvents([body]);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json({ ok: false, error: "validation_error", details: err.flatten() }, 400);
    }
    console.error("[events] insert failed", err);
    return c.json({ ok: false, error: "internal_error" }, 500);
  }
});

// POST /api/v1/events/batch — up to 100 events in one request
// (recommended for the extension: queue events client-side, flush every
// few seconds or on page unload, rather than one HTTP request per signal)
events.post("/batch", async (c) => {
  try {
    const body = eventBatchSchema.parse(await c.req.json());
    const count = await ingestEvents(body.events);
    return c.json({ ok: true, count });
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json({ ok: false, error: "validation_error", details: err.flatten() }, 400);
    }
    console.error("[events/batch] insert failed", err);
    return c.json({ ok: false, error: "internal_error" }, 500);
  }
});

export default events;
