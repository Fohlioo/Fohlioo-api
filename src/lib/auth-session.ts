import { supabase } from "./supabase";

export interface MintedSession {
  access_token: string;
  refresh_token: string;
  user_id: string;
  /** Unix milliseconds — matches the extension parser. */
  expires_at: number;
}

/**
 * Mints a real user session via GoTrue admin generateLink + verifyOtp.
 * Never invents JWTs; if either step fails the caller returns 500.
 */
export async function mintUserSession(userId: string): Promise<MintedSession> {
  const { data: userData, error: userError } =
    await supabase.auth.admin.getUserById(userId);

  if (userError || !userData.user?.email) {
    throw new Error(
      `Cannot mint session: user ${userId} has no email (${userError?.message ?? "missing"})`
    );
  }

  const { data: linkData, error: linkError } =
    await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });

  const hashedToken = linkData?.properties?.hashed_token;
  if (linkError || !hashedToken) {
    throw new Error(
      `generateLink failed: ${linkError?.message ?? "no hashed_token"}`
    );
  }

  const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: hashedToken,
  });

  const session = otpData.session;
  if (otpError || !session?.access_token || !session.refresh_token) {
    throw new Error(
      `verifyOtp failed: ${otpError?.message ?? "no session tokens"}`
    );
  }

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    user_id: userId,
    expires_at: toUnixMs(session.expires_at, session.expires_in),
  };
}

export function toUnixMs(
  expiresAt: number | undefined,
  expiresIn: number | undefined,
  now: number = Date.now()
): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return expiresAt < 1_000_000_000_000 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    return now + expiresIn * 1000;
  }
  return now + 3600 * 1000;
}
