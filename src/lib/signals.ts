import { supabase } from "./supabase";

/**
 * Derived shopper signals — computed from the raw events log after each
 * ingest. Definitions follow the Extension Data Capture & Segmentation
 * Engine spec (Notion) and the reference implementations in the extension
 * repo's fohlioo.cursorrules.
 *
 * A null signal means "not derivable yet" (e.g. no purchases → no
 * return_rate), never zero. The classifier treats null as a failed
 * condition rather than a strong signal.
 */

/** The subset of an `events` row the signals engine reads. */
export interface SignalEvent {
  event_type: string;
  product_url: string | null;
  product_brand: string | null;
  product_price: number | null;
  original_price: number | null;
  colour: string | null;
  /** ISO timestamp (events.occurred_at) */
  occurred_at: string;
  payload: Record<string, unknown> | null;
}

export interface DerivedSignals {
  consideration_arc_days: number | null;
  dwell_time_p75_ms: number | null;
  return_rate: number | null;
  full_price_rate: number | null;
  brand_hhi_index: number | null;
  colour_palette_entropy: number | null;
  purchase_frequency_30d: number;
  avg_order_value: number | null;
  unique_brands_30d: number;
  sale_browse_ratio: number | null;
  event_count: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A purchase within 5% of the original price still counts as full price. */
const FULL_PRICE_TOLERANCE = 0.95;

function normalizeLabel(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Strips query/hash so SPA param drift doesn't split one product into many. */
export function normalizeProductUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank 75th percentile. */
export function percentile75(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.75 * sorted.length) - 1];
}

/**
 * Herfindahl-Hirschman Index on a count distribution.
 * Near 1 = highly concentrated (Brand Loyalist); near 0 = highly spread.
 */
export function computeHhi(counts: Map<string, number>): number | null {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return [...counts.values()]
    .map((count) => (count / total) ** 2)
    .reduce((a, b) => a + b, 0);
}

/**
 * Shannon entropy (bits) on a count distribution.
 * Low = consistent palette (Quiet Minimalist); high = varied (Trend Chaser).
 * Raw bits, not normalised — the QM threshold (< 0.3) expects one strongly
 * dominant colour regardless of how many minor colours appear.
 */
export function computeShannonEntropy(counts: Map<string, number>): number | null {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const entropy = -[...counts.values()]
    .map((count) => {
      const p = count / total;
      return p > 0 ? p * Math.log2(p) : 0;
    })
    .reduce((a, b) => a + b, 0);
  // A single-value distribution yields IEEE -0 from `-0`; normalise to +0.
  return entropy === 0 ? 0 : entropy;
}

function isFullPricePurchase(event: SignalEvent): boolean {
  if (event.original_price == null) return true;
  if (event.product_price == null) return false;
  return event.product_price >= event.original_price * FULL_PRICE_TOLERANCE;
}

/**
 * Derives all shopper signals from a chronological event log.
 * Pure — no I/O — so it can be unit-tested against fixtures.
 */
export function deriveSignals(
  events: SignalEvent[],
  now: Date = new Date()
): DerivedSignals {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - THIRTY_DAYS_MS;

  const pageViews = events.filter((e) => e.event_type === "page_view");
  const purchases = events.filter((e) => e.event_type === "purchase_confirmed");
  const returns = events.filter((e) => e.event_type === "return_initiated");

  // --- Brand concentration (HHI) over every event carrying a brand ---
  const brandCounts = new Map<string, number>();
  for (const event of events) {
    const brand = normalizeLabel(event.product_brand);
    if (brand) brandCounts.set(brand, (brandCounts.get(brand) ?? 0) + 1);
  }

  // --- Colour entropy over viewed + saved items ---
  const colourCounts = new Map<string, number>();
  for (const event of events) {
    if (event.event_type !== "page_view" && event.event_type !== "wishlist_add") {
      continue;
    }
    const colour = normalizeLabel(event.colour);
    if (colour) colourCounts.set(colour, (colourCounts.get(colour) ?? 0) + 1);
  }

  // --- Dwell P75: best dwell milestone per product, P75 across products ---
  const dwellByProduct = new Map<string, number>();
  for (const event of events) {
    if (event.event_type !== "dwell_milestone") continue;
    const dwellMs = event.payload?.dwell_ms;
    if (typeof dwellMs !== "number" || !Number.isFinite(dwellMs)) continue;
    const key = normalizeProductUrl(event.product_url) ?? "unknown";
    dwellByProduct.set(key, Math.max(dwellByProduct.get(key) ?? 0, dwellMs));
  }

  // --- Consideration arc: first page_view → purchase, per product ---
  // Edge case (Notion spec): a purchase with no prior page_view for that
  // product (e.g. browsed on mobile, bought on desktop) is left UNKNOWN
  // rather than recorded as a 0-day arc.
  const firstViewByProduct = new Map<string, number>();
  for (const view of pageViews) {
    const key = normalizeProductUrl(view.product_url);
    if (!key) continue;
    const ts = Date.parse(view.occurred_at);
    const existing = firstViewByProduct.get(key);
    if (existing === undefined || ts < existing) firstViewByProduct.set(key, ts);
  }

  const arcs: number[] = [];
  for (const purchase of purchases) {
    const key = normalizeProductUrl(purchase.product_url);
    if (!key) continue;
    const firstView = firstViewByProduct.get(key);
    const purchasedAt = Date.parse(purchase.occurred_at);
    if (firstView === undefined || firstView > purchasedAt) continue;
    arcs.push((purchasedAt - firstView) / DAY_MS);
  }

  // --- Sale browsing: proportion of product views on discounted items ---
  const discountedViews = pageViews.filter(
    (e) =>
      e.original_price != null &&
      e.product_price != null &&
      e.original_price > e.product_price
  );

  // --- Rolling 30-day windows ---
  const inWindow = (e: SignalEvent) => Date.parse(e.occurred_at) >= windowStartMs;
  const brands30d = new Set<string>();
  for (const event of events.filter(inWindow)) {
    const brand = normalizeLabel(event.product_brand);
    if (brand) brands30d.add(brand);
  }

  const orderValues = purchases
    .map((e) => e.product_price)
    .filter((price): price is number => price != null);

  return {
    consideration_arc_days: mean(arcs),
    dwell_time_p75_ms: percentile75([...dwellByProduct.values()]),
    return_rate:
      purchases.length > 0 ? returns.length / purchases.length : null,
    full_price_rate:
      purchases.length > 0
        ? purchases.filter(isFullPricePurchase).length / purchases.length
        : null,
    brand_hhi_index: computeHhi(brandCounts),
    colour_palette_entropy: computeShannonEntropy(colourCounts),
    purchase_frequency_30d: purchases.filter(inWindow).length,
    avg_order_value: mean(orderValues),
    unique_brands_30d: brands30d.size,
    sale_browse_ratio:
      pageViews.length > 0 ? discountedViews.length / pageViews.length : null,
    event_count: events.length,
  };
}

/** Cap on how much history one recompute reads — plenty for Phase 1 volumes. */
const MAX_EVENTS_PER_RECOMPUTE = 5000;

/**
 * Recomputes a shopper's signals from their event log and upserts the
 * result into shopper_signals. Returns the derived signals so the
 * classifier can run on them without a second read.
 */
export async function computeShopperSignals(
  shopperId: string
): Promise<DerivedSignals> {
  const { data, error } = await supabase
    .from("events")
    .select(
      "event_type, product_url, product_brand, product_price, original_price, colour, occurred_at, payload"
    )
    .eq("shopper_id", shopperId)
    .order("occurred_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RECOMPUTE);

  if (error) {
    throw new Error(`Failed to load events for signals: ${error.message}`);
  }

  const signals = deriveSignals((data ?? []) as SignalEvent[]);

  const { error: upsertError } = await supabase.from("shopper_signals").upsert({
    shopper_id: shopperId,
    ...signals,
    updated_at: new Date().toISOString(),
  });

  if (upsertError) {
    throw new Error(`Failed to upsert shopper_signals: ${upsertError.message}`);
  }

  return signals;
}
