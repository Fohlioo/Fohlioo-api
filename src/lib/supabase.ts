import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables. " +
      "Copy .env.example to .env and fill these in from your Supabase project settings (Project Settings → API)."
  );
}

// Service role key — this server trusts itself to write on behalf of
// shoppers who are identified only by an anonymous extension_id, so RLS
// is bypassed here by design. Never expose this key to the extension or
// any client-side code; it only ever lives in this backend's environment.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});
