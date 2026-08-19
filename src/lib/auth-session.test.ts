import { describe, expect, test } from "vitest";
import { toUnixMs } from "./auth-session";

describe("toUnixMs", () => {
  const now = 1_700_000_000_000;

  test("treats small expires_at values as unix seconds", () => {
    expect(toUnixMs(1_700_000_000, undefined, now)).toBe(1_700_000_000_000);
  });

  test("passes through unix milliseconds", () => {
    expect(toUnixMs(1_700_000_000_000, undefined, now)).toBe(1_700_000_000_000);
  });

  test("falls back to expires_in seconds from now", () => {
    expect(toUnixMs(undefined, 3600, now)).toBe(now + 3_600_000);
  });
});
