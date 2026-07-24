import { describe, expect, test } from "vitest";
import { classifySegment, MIN_EVENTS_TO_CLASSIFY } from "./segments";
import type { DerivedSignals } from "./signals";

function signals(overrides: Partial<DerivedSignals> = {}): DerivedSignals {
  return {
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
    event_count: 50,
    ...overrides,
  };
}

describe("classifySegment", () => {
  test("stays unclassified below the minimum event count", () => {
    const result = classifySegment(
      signals({
        event_count: MIN_EVENTS_TO_CLASSIFY - 1,
        // Signals that would otherwise classify as Investment Dresser:
        consideration_arc_days: 14,
        dwell_time_p75_ms: 142_000,
        return_rate: 0.07,
        full_price_rate: 0.84,
      })
    );
    expect(result.segment).toBe("unclassified");
    expect(result.confidence).toBe(0);
  });

  test("stays unclassified when no rule's signals exist yet", () => {
    const result = classifySegment(signals({ event_count: 100 }));
    expect(result.segment).toBe("unclassified");
  });

  test("classifies the Notion worked example as Investment Dresser", () => {
    // Shopper A from the segmentation spec: arc 14d, dwell P75 142s,
    // return 7%, full price 84%, brand HHI 0.38.
    const result = classifySegment(
      signals({
        consideration_arc_days: 14,
        dwell_time_p75_ms: 142_000,
        return_rate: 0.07,
        full_price_rate: 0.84,
        brand_hhi_index: 0.38,
        purchase_frequency_30d: 1,
      })
    );
    expect(result.segment).toBe("investment_dresser");
    // Factors: 14/21, 142/180, 0.93, 0.84 → mean ≈ 0.806
    expect(result.confidence).toBeCloseTo(0.806, 2);
    expect(result.signals_used).toContain("consideration_arc_days");
  });

  test("classifies concentrated full-price shoppers as Brand Loyalist", () => {
    const result = classifySegment(
      signals({
        brand_hhi_index: 0.8,
        full_price_rate: 0.7,
      })
    );
    expect(result.segment).toBe("brand_loyalist");
    expect(result.confidence).toBeCloseTo(0.75, 6);
  });

  test("classifies tight-palette low-return shoppers as Quiet Minimalist", () => {
    const result = classifySegment(
      signals({
        colour_palette_entropy: 0.2,
        return_rate: 0.05,
        brand_hhi_index: 0.4, // below the Brand Loyalist threshold
        full_price_rate: 0.6,
      })
    );
    expect(result.segment).toBe("quiet_minimalist");
    expect(result.confidence).toBeCloseTo(0.875, 6);
  });

  test("classifies fast frequent high-return shoppers as Trend Chaser", () => {
    const result = classifySegment(
      signals({
        consideration_arc_days: 1,
        purchase_frequency_30d: 4,
        return_rate: 0.35,
        dwell_time_p75_ms: 20_000,
        full_price_rate: 0.3,
        brand_hhi_index: 0.2,
        colour_palette_entropy: 1.5,
      })
    );
    expect(result.segment).toBe("trend_chaser");
    // Factors: (1 - 1/3), 4/5, 0.35 → mean ≈ 0.606
    expect(result.confidence).toBeCloseTo(0.606, 2);
  });

  test("Investment Dresser wins when its rule and Brand Loyalist both fire", () => {
    const result = classifySegment(
      signals({
        consideration_arc_days: 10,
        dwell_time_p75_ms: 100_000,
        return_rate: 0.05,
        full_price_rate: 0.9,
        brand_hhi_index: 0.9,
      })
    );
    expect(result.segment).toBe("investment_dresser");
  });

  test("null return_rate blocks Quiet Minimalist (no purchases yet)", () => {
    const result = classifySegment(
      signals({
        colour_palette_entropy: 0.1,
        return_rate: null,
      })
    );
    expect(result.segment).toBe("unclassified");
  });
});
