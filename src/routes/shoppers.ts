import { Hono } from "hono";
import { supabase } from "../lib/supabase";

const shoppers = new Hono();

// GET /api/v1/shoppers/:extension_id — profile + segment + derived signals.
// Read by the extension popup (style accuracy) and the future web app.
// Keyed by extension_id rather than the internal uuid because that's the
// only identifier the extension holds before auth exists.
shoppers.get("/:extension_id", async (c) => {
  const extensionId = c.req.param("extension_id");

  const { data: shopper, error } = await supabase
    .from("shoppers")
    .select(
      "id, extension_id, email, segment, segment_confidence, event_count, last_active_at, created_at"
    )
    .eq("extension_id", extensionId)
    .maybeSingle();

  if (error) {
    console.error("[shoppers] lookup failed", error);
    return c.json({ ok: false, error: "internal_error" }, 500);
  }

  if (!shopper) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }

  const { data: signals, error: signalsError } = await supabase
    .from("shopper_signals")
    .select(
      "consideration_arc_days, dwell_time_p75_ms, return_rate, full_price_rate, brand_hhi_index, colour_palette_entropy, purchase_frequency_30d, avg_order_value, unique_brands_30d, sale_browse_ratio, event_count, updated_at"
    )
    .eq("shopper_id", shopper.id)
    .maybeSingle();

  if (signalsError) {
    console.error("[shoppers] signals lookup failed", signalsError);
    return c.json({ ok: false, error: "internal_error" }, 500);
  }

  return c.json({
    ok: true,
    shopper: {
      extension_id: shopper.extension_id,
      email: shopper.email,
      segment: shopper.segment,
      segment_confidence: shopper.segment_confidence,
      event_count: shopper.event_count,
      last_active_at: shopper.last_active_at,
      created_at: shopper.created_at,
    },
    signals: signals ?? null,
  });
});

export default shoppers;
