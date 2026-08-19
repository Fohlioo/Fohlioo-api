import { describe, expect, test } from "vitest";
import { evaluateAuthCode, type AuthCodeRow } from "./auth-codes";

const NOW = new Date("2026-08-19T00:30:00Z");

function row(overrides: Partial<AuthCodeRow> = {}): AuthCodeRow {
  return {
    code: "code-1",
    user_id: "user-1",
    extension_id: "ext-1",
    expires_at: "2026-08-19T00:31:00Z",
    used: false,
    ...overrides,
  };
}

describe("evaluateAuthCode", () => {
  test("accepts a fresh matching code", () => {
    expect(evaluateAuthCode(row(), "ext-1", NOW)).toEqual({
      ok: true,
      user_id: "user-1",
    });
  });

  test("rejects a missing row", () => {
    expect(evaluateAuthCode(null, "ext-1", NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("rejects a used code", () => {
    expect(evaluateAuthCode(row({ used: true }), "ext-1", NOW)).toEqual({
      ok: false,
      reason: "used",
    });
  });

  test("rejects an expired code", () => {
    expect(
      evaluateAuthCode(row({ expires_at: "2026-08-19T00:29:00Z" }), "ext-1", NOW)
    ).toEqual({ ok: false, reason: "expired" });
  });

  test("rejects a mismatched extension_id", () => {
    expect(evaluateAuthCode(row(), "ext-other", NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});
