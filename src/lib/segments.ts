import { supabase } from "./supabase";
import { computeShopperSignals, type DerivedSignals } from "./signals";

/**
 * Phase 1 cold-start rule engine — classifies a shopper into one of the
 * four behavioural archetypes from derived signals. Thresholds follow the
 * Extension Data Capture & Segmentation Engine spec (Notion) and the
 * extension repo's fohlioo.cursorrules. Runs server-side only; the
 * extension never classifies.
 *
 * Confidence at this stage is 30-45% territory by design — the weighted
 * scoring model takes over at 30+ events (Phase 2). Never surface
 * provisional segments to brands.
 */

export const SEGMENTS = [
  "investment_dresser",
  "trend_chaser",
  "quiet_minimalist",
  "brand_loyalist",
  "unclassified",
] as const;

export type Segment = (typeof SEGMENTS)[number];

export interface SegmentResult {
  segment: Segment;
  /** 0-1 */
  confidence: number;
  signals_used: string[];
}

/** Below this many events, classification is meaningless — stay unclassified. */
export const MIN_EVENTS_TO_CLASSIFY = 10;

const UNCLASSIFIED: SegmentResult = {
  segment: "unclassified",
  confidence: 0,
  signals_used: [],
};

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Average of clamped factors — each factor is a 0-1 "how strongly does this signal fit". */
function confidenceFrom(factors: number[]): number {
  const avg = factors.reduce((a, b) => a + b, 0) / factors.length;
  return clamp01(avg);
}

/**
 * Rule order matters: Investment Dresser is checked first because its rule
 * is the most specific (four conditions), Trend Chaser last because sale
 * events inflate its false positives (Notion edge cases). Null signals fail
 * every comparison, so a rule only fires when its inputs actually exist.
 */
export function classifySegment(signals: DerivedSignals): SegmentResult {
  const {
    consideration_arc_days,
    dwell_time_p75_ms,
    return_rate,
    full_price_rate,
    brand_hhi_index,
    colour_palette_entropy,
    purchase_frequency_30d,
    event_count,
  } = signals;

  if (event_count < MIN_EVENTS_TO_CLASSIFY) {
    return { ...UNCLASSIFIED };
  }

  // Investment Dresser — long consideration arc, deep engagement,
  // almost never returns, buys at full price.
  if (
    consideration_arc_days != null &&
    consideration_arc_days > 7 &&
    dwell_time_p75_ms != null &&
    dwell_time_p75_ms > 90_000 &&
    return_rate != null &&
    return_rate < 0.12 &&
    full_price_rate != null &&
    full_price_rate > 0.75
  ) {
    return {
      segment: "investment_dresser",
      confidence: confidenceFrom([
        clamp01(consideration_arc_days / 21), // 21d = top of the ID arc band
        clamp01(dwell_time_p75_ms / 180_000), // 180s = deepest dwell milestone
        1 - return_rate,
        full_price_rate,
      ]),
      signals_used: [
        "consideration_arc_days",
        "dwell_time_p75_ms",
        "return_rate",
        "full_price_rate",
      ],
    };
  }

  // Brand Loyalist — concentrated brand distribution, pays full price.
  if (
    brand_hhi_index != null &&
    brand_hhi_index > 0.65 &&
    full_price_rate != null &&
    full_price_rate > 0.65
  ) {
    return {
      segment: "brand_loyalist",
      confidence: confidenceFrom([brand_hhi_index, full_price_rate]),
      signals_used: ["brand_hhi_index", "full_price_rate"],
    };
  }

  // Quiet Minimalist — tight neutral palette, lowest returns of any segment.
  if (
    colour_palette_entropy != null &&
    colour_palette_entropy < 0.3 &&
    return_rate != null &&
    return_rate < 0.08
  ) {
    return {
      segment: "quiet_minimalist",
      confidence: confidenceFrom([
        clamp01(1 - colour_palette_entropy),
        1 - return_rate,
      ]),
      signals_used: ["colour_palette_entropy", "return_rate"],
    };
  }

  // Trend Chaser — fast decisions, frequent purchases, high returns.
  if (
    consideration_arc_days != null &&
    consideration_arc_days < 3 &&
    purchase_frequency_30d > 2 &&
    return_rate != null &&
    return_rate > 0.25
  ) {
    return {
      segment: "trend_chaser",
      confidence: confidenceFrom([
        clamp01(1 - consideration_arc_days / 3),
        clamp01(purchase_frequency_30d / 5),
        clamp01(return_rate),
      ]),
      signals_used: [
        "consideration_arc_days",
        "purchase_frequency_30d",
        "return_rate",
      ],
    };
  }

  return { ...UNCLASSIFIED };
}

/** History rows are only appended when the segment or confidence band moves. */
function confidenceBand(confidence: number): number {
  return Math.round(confidence * 10);
}

/**
 * Full post-ingest pipeline for one shopper: recompute signals → classify →
 * persist segment on the shopper row → append segment_history when the
 * classification meaningfully changed. Called fire-and-forget after each
 * ingest request; must never throw into the request path.
 */
export async function refreshShopperIntelligence(
  shopperId: string
): Promise<SegmentResult> {
  const signals = await computeShopperSignals(shopperId);
  const result = classifySegment(signals);

  const { data: shopper, error: readError } = await supabase
    .from("shoppers")
    .select("segment, segment_confidence")
    .eq("id", shopperId)
    .single();

  if (readError || !shopper) {
    throw new Error(
      `Failed to read shopper ${shopperId}: ${readError?.message}`
    );
  }

  const { error: updateError } = await supabase
    .from("shoppers")
    .update({
      segment: result.segment,
      segment_confidence: result.confidence,
    })
    .eq("id", shopperId);

  if (updateError) {
    throw new Error(`Failed to update shopper segment: ${updateError.message}`);
  }

  const previousConfidence = Number(shopper.segment_confidence ?? 0);
  const changed =
    shopper.segment !== result.segment ||
    confidenceBand(previousConfidence) !== confidenceBand(result.confidence);

  if (changed) {
    const { error: historyError } = await supabase
      .from("segment_history")
      .insert({
        shopper_id: shopperId,
        segment: result.segment,
        confidence: result.confidence,
        event_count_at_time: signals.event_count,
      });

    if (historyError) {
      throw new Error(
        `Failed to append segment_history: ${historyError.message}`
      );
    }
  }

  return result;
}
