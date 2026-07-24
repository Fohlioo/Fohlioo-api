import { describe, expect, test } from "vitest";
import {
  computeHhi,
  computeShannonEntropy,
  deriveSignals,
  normalizeProductUrl,
  percentile75,
  type SignalEvent,
} from "./signals";

/** Fixed "now" so 30-day windows are deterministic. */
const NOW = new Date("2026-07-24T00:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function event(
  overrides: Partial<SignalEvent> & { event_type: string }
): SignalEvent {
  return {
    product_url: null,
    product_brand: null,
    product_price: null,
    original_price: null,
    colour: null,
    occurred_at: NOW.toISOString(),
    payload: null,
    ...overrides,
  };
}

describe("helpers", () => {
  test("percentile75 uses nearest rank", () => {
    expect(percentile75([30_000, 60_000, 90_000, 120_000])).toBe(90_000);
    expect(percentile75([42])).toBe(42);
    expect(percentile75([])).toBeNull();
  });

  test("HHI on a 75/25 split is 0.625", () => {
    const counts = new Map([
      ["cos", 3],
      ["toteme", 1],
    ]);
    expect(computeHhi(counts)).toBeCloseTo(0.625, 6);
  });

  test("Shannon entropy on a 75/25 split is ~0.8113 bits", () => {
    const counts = new Map([
      ["black", 3],
      ["white", 1],
    ]);
    expect(computeShannonEntropy(counts)).toBeCloseTo(0.8113, 3);
  });

  test("single-value distribution has zero entropy", () => {
    expect(computeShannonEntropy(new Map([["black", 5]]))).toBe(0);
  });

  test("normalizeProductUrl strips query and hash", () => {
    expect(normalizeProductUrl("https://cos.com/p/1?ref=abc#gallery")).toBe(
      "https://cos.com/p/1"
    );
  });
});

describe("deriveSignals", () => {
  test("empty event log yields nulls and zero counts", () => {
    const signals = deriveSignals([], NOW);
    expect(signals).toEqual({
      consideration_arc_days: null,
      dwell_time_p75_ms: null,
      return_rate: null,
      full_price_rate: null,
      brand_hhi_index: null,
      colour_palette_entropy: null,
      purchase_frequency_30d: 0,
      avg_order_value: null,
      unique_brands_30d: 0,
      sale_browse_ratio: null,
      event_count: 0,
    });
  });

  test("brand HHI counts every event carrying a brand, case-insensitively", () => {
    const signals = deriveSignals(
      [
        event({ event_type: "page_view", product_brand: "COS" }),
        event({ event_type: "wishlist_add", product_brand: "cos" }),
        event({ event_type: "add_to_cart", product_brand: "Cos" }),
        event({ event_type: "page_view", product_brand: "Toteme" }),
      ],
      NOW
    );
    expect(signals.brand_hhi_index).toBeCloseTo(0.625, 6);
  });

  test("colour entropy reads views and saves only", () => {
    const signals = deriveSignals(
      [
        event({ event_type: "page_view", colour: "Black" }),
        event({ event_type: "page_view", colour: "black" }),
        event({ event_type: "wishlist_add", colour: "black" }),
        event({ event_type: "page_view", colour: "white" }),
        // Cart events don't count toward the palette:
        event({ event_type: "add_to_cart", colour: "red" }),
      ],
      NOW
    );
    expect(signals.colour_palette_entropy).toBeCloseTo(0.8113, 3);
  });

  test("dwell P75 takes the best milestone per product", () => {
    const dwell = (url: string, ms: number) =>
      event({
        event_type: "dwell_milestone",
        product_url: url,
        payload: { dwell_ms: ms },
      });

    const signals = deriveSignals(
      [
        dwell("https://cos.com/p/a", 15_000),
        dwell("https://cos.com/p/a", 60_000), // max for product a
        dwell("https://cos.com/p/b", 30_000),
        dwell("https://cos.com/p/c", 90_000),
        dwell("https://cos.com/p/d", 120_000),
      ],
      NOW
    );
    // Per-product maxima: [60000, 30000, 90000, 120000] → P75 = 90000
    expect(signals.dwell_time_p75_ms).toBe(90_000);
  });

  test("consideration arc spans first view to purchase per product", () => {
    const signals = deriveSignals(
      [
        event({
          event_type: "page_view",
          product_url: "https://cos.com/p/blazer?ref=feed",
          occurred_at: daysAgo(10),
        }),
        event({
          event_type: "page_view",
          product_url: "https://cos.com/p/blazer",
          occurred_at: daysAgo(4),
        }),
        event({
          event_type: "purchase_confirmed",
          product_url: "https://cos.com/p/blazer",
          occurred_at: daysAgo(0),
        }),
      ],
      NOW
    );
    expect(signals.consideration_arc_days).toBeCloseTo(10, 6);
  });

  test("purchase with no prior view leaves arc unknown, not zero", () => {
    const signals = deriveSignals(
      [
        event({
          event_type: "purchase_confirmed",
          product_url: "https://zara.com/p/jacket",
          occurred_at: daysAgo(0),
        }),
      ],
      NOW
    );
    expect(signals.consideration_arc_days).toBeNull();
  });

  test("return and full-price rates derive from purchases", () => {
    const signals = deriveSignals(
      [
        // Full price (no original price on the product):
        event({
          event_type: "purchase_confirmed",
          product_price: 200,
          occurred_at: daysAgo(2),
        }),
        // Bought at half the original price:
        event({
          event_type: "purchase_confirmed",
          product_price: 50,
          original_price: 100,
          occurred_at: daysAgo(1),
        }),
        event({ event_type: "return_initiated", occurred_at: daysAgo(0) }),
      ],
      NOW
    );
    expect(signals.return_rate).toBeCloseTo(0.5, 6);
    expect(signals.full_price_rate).toBeCloseTo(0.5, 6);
    expect(signals.avg_order_value).toBeCloseTo(125, 6);
  });

  test("sale browse ratio is discounted views over all views", () => {
    const signals = deriveSignals(
      [
        event({ event_type: "page_view", product_price: 80 }),
        event({ event_type: "page_view", product_price: 120 }),
        event({ event_type: "page_view", product_price: 90, original_price: 90 }),
        event({ event_type: "page_view", product_price: 50, original_price: 100 }),
      ],
      NOW
    );
    expect(signals.sale_browse_ratio).toBeCloseTo(0.25, 6);
  });

  test("30-day windows exclude older events", () => {
    const signals = deriveSignals(
      [
        event({
          event_type: "purchase_confirmed",
          product_brand: "Arket",
          occurred_at: daysAgo(40),
        }),
        event({
          event_type: "purchase_confirmed",
          product_brand: "COS",
          occurred_at: daysAgo(5),
        }),
        event({
          event_type: "page_view",
          product_brand: "cos",
          occurred_at: daysAgo(3),
        }),
      ],
      NOW
    );
    expect(signals.purchase_frequency_30d).toBe(1);
    expect(signals.unique_brands_30d).toBe(1);
    expect(signals.event_count).toBe(3);
  });
});
