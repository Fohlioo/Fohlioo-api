import { Hono } from "hono";
import { ZodError } from "zod";
import { supabase } from "../lib/supabase";
import { authExchangeSchema } from "../lib/schema";
import { evaluateAuthCode, type AuthCodeRow } from "../lib/auth-codes";
import { mintUserSession } from "../lib/auth-session";
import { linkShopperToUser } from "../lib/shopper-link";

const auth = new Hono();

/**
 * POST /api/v1/auth/exchange
 * Extension sends { code, extension_id } after the webapp posts a one-time
 * code. No ingest key — the code itself is the credential.
 */
auth.post("/exchange", async (c) => {
  try {
    const body = authExchangeSchema.parse(await c.req.json());

    const { data: row, error: loadError } = await supabase
      .from("extension_auth_codes")
      .select("code, user_id, extension_id, expires_at, used")
      .eq("code", body.code)
      .maybeSingle();

    if (loadError) {
      console.error("[auth/exchange] lookup failed", loadError);
      return c.json({ ok: false, error: "internal_error" }, 500);
    }

    const verdict = evaluateAuthCode(row as AuthCodeRow | null, body.extension_id);
    if (!verdict.ok) {
      return c.json({ ok: false, error: "invalid_code", reason: verdict.reason }, 401);
    }

    // Claim atomically so a retry cannot mint twice.
    const { data: claimed, error: claimError } = await supabase
      .from("extension_auth_codes")
      .update({ used: true })
      .eq("code", body.code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .eq("extension_id", body.extension_id)
      .select("code")
      .maybeSingle();

    if (claimError) {
      console.error("[auth/exchange] claim failed", claimError);
      return c.json({ ok: false, error: "internal_error" }, 500);
    }

    if (!claimed) {
      return c.json({ ok: false, error: "invalid_code", reason: "used" }, 401);
    }

    let session;
    try {
      session = await mintUserSession(verdict.user_id);
    } catch (err) {
      console.error("[auth/exchange] mint failed", err);
      return c.json({ ok: false, error: "token_mint_failed" }, 500);
    }

    try {
      await linkShopperToUser(body.extension_id, verdict.user_id);
    } catch (err) {
      console.error("[auth/exchange] shopper link failed", err);
      const message = err instanceof Error ? err.message : "";
      if (message.includes("different account")) {
        return c.json({ ok: false, error: "install_conflict" }, 409);
      }
      return c.json({ ok: false, error: "internal_error" }, 500);
    }

    return c.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user_id: session.user_id,
      expires_at: session.expires_at,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json(
        { ok: false, error: "validation_error", details: err.flatten() },
        400
      );
    }
    console.error("[auth/exchange] failed", err);
    return c.json({ ok: false, error: "internal_error" }, 500);
  }
});

export default auth;
