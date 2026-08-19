/**
 * Pure checks for the one-time extension login code.
 * The route still claims the row atomically in the database; this module
 * decides *why* a code is invalid so tests don't need Supabase.
 */

export interface AuthCodeRow {
  code: string;
  user_id: string;
  extension_id: string;
  expires_at: string;
  used: boolean;
}

export type AuthCodeRejection = "missing" | "used" | "expired" | "mismatch";

export type AuthCodeVerdict =
  | { ok: true; user_id: string }
  | { ok: false; reason: AuthCodeRejection };

export function evaluateAuthCode(
  row: AuthCodeRow | null,
  extensionId: string,
  now: Date = new Date()
): AuthCodeVerdict {
  if (!row) return { ok: false, reason: "missing" };
  if (row.used) return { ok: false, reason: "used" };
  if (Date.parse(row.expires_at) <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (row.extension_id !== extensionId) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, user_id: row.user_id };
}
