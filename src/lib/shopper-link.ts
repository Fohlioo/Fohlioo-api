import { supabase } from "./supabase";
import { planShopperMerge, type ShopperRow } from "./shopper-merge";
import { refreshShopperIntelligence } from "./segments";

function asShopper(row: {
  id: string;
  extension_id: string;
  user_id: string | null;
  event_count: number | null;
}): ShopperRow {
  return {
    id: row.id,
    extension_id: row.extension_id,
    user_id: row.user_id,
    event_count: row.event_count ?? 0,
  };
}

/**
 * Finds or creates the shopper for this install, records it in
 * shopper_installs, then attaches or merges it onto the Auth user.
 */
export async function linkShopperToUser(
  extensionId: string,
  userId: string
): Promise<string> {
  const install = await resolveInstallShopper(extensionId);

  const { data: existingForUser, error: userLookupError } = await supabase
    .from("shoppers")
    .select("id, extension_id, user_id, event_count")
    .eq("user_id", userId)
    .maybeSingle();

  if (userLookupError) {
    throw new Error(`Failed to look up shopper for user: ${userLookupError.message}`);
  }

  const plan = planShopperMerge(
    asShopper(install),
    existingForUser ? asShopper(existingForUser) : null,
    userId
  );

  if (plan.action === "conflict") {
    throw new Error("This extension install is already linked to a different account");
  }

  if (plan.action === "already_linked") {
    return plan.shopperId;
  }

  if (plan.action === "attach") {
    const { error } = await supabase
      .from("shoppers")
      .update({ user_id: userId })
      .eq("id", plan.shopperId);

    if (error) {
      throw new Error(`Failed to attach shopper to user: ${error.message}`);
    }
    return plan.shopperId;
  }

  await reassignInstallToCanonical(
    plan.fromShopperId,
    plan.toShopperId,
    extensionId,
    install.event_count ?? 0
  );
  return plan.toShopperId;
}

async function resolveInstallShopper(extensionId: string): Promise<{
  id: string;
  extension_id: string;
  user_id: string | null;
  event_count: number | null;
}> {
  const { data: mapping } = await supabase
    .from("shopper_installs")
    .select("shopper_id")
    .eq("extension_id", extensionId)
    .maybeSingle();

  if (mapping?.shopper_id) {
    const { data, error } = await supabase
      .from("shoppers")
      .select("id, extension_id, user_id, event_count")
      .eq("id", mapping.shopper_id)
      .single();
    if (error || !data) {
      throw new Error(`Failed to load mapped shopper: ${error?.message}`);
    }
    return data;
  }

  const { data, error } = await supabase
    .from("shoppers")
    .upsert({ extension_id: extensionId }, { onConflict: "extension_id" })
    .select("id, extension_id, user_id, event_count")
    .single();

  if (error || !data) {
    throw new Error(`Failed to resolve shopper: ${error?.message}`);
  }

  await supabase.from("shopper_installs").upsert(
    { extension_id: extensionId, shopper_id: data.id },
    { onConflict: "extension_id" }
  );

  return data;
}

async function reassignInstallToCanonical(
  fromShopperId: string,
  toShopperId: string,
  extensionId: string,
  fromEventCount: number
): Promise<void> {
  const { error: eventsError } = await supabase
    .from("events")
    .update({ shopper_id: toShopperId })
    .eq("shopper_id", fromShopperId);

  if (eventsError) {
    throw new Error(`Failed to move events: ${eventsError.message}`);
  }

  const { error: historyError } = await supabase
    .from("segment_history")
    .update({ shopper_id: toShopperId })
    .eq("shopper_id", fromShopperId);

  if (historyError) {
    throw new Error(`Failed to move segment history: ${historyError.message}`);
  }

  await supabase.from("shopper_signals").delete().eq("shopper_id", fromShopperId);

  const { error: installError } = await supabase
    .from("shopper_installs")
    .update({ shopper_id: toShopperId })
    .eq("extension_id", extensionId);

  if (installError) {
    throw new Error(`Failed to re-point install: ${installError.message}`);
  }

  const { error: countError } = await supabase.rpc("increment_shopper_activity", {
    p_shopper_id: toShopperId,
    p_count: fromEventCount,
  });

  if (countError) {
    throw new Error(`Failed to merge event_count: ${countError.message}`);
  }

  const { error: deleteError } = await supabase
    .from("shoppers")
    .delete()
    .eq("id", fromShopperId);

  if (deleteError) {
    throw new Error(`Failed to drop merged shopper: ${deleteError.message}`);
  }

  refreshShopperIntelligence(toShopperId).catch((err) =>
    console.error(`[intelligence] refresh failed after merge shopper=${toShopperId}`, err)
  );
}
