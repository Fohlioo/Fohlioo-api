/**
 * Decides how to attach an extension install to a signed-in Auth user.
 * Execution (the SQL) lives in shopper-link.ts; this file is the pure plan
 * so the second-install / already-linked cases are unit-testable.
 */

export interface ShopperRow {
  id: string;
  extension_id: string;
  user_id: string | null;
  event_count: number;
}

export type ShopperMergePlan =
  | { action: "already_linked"; shopperId: string }
  | { action: "attach"; shopperId: string }
  | { action: "reassign"; fromShopperId: string; toShopperId: string }
  | { action: "conflict"; reason: "install_owned_by_other_user" };

/**
 * `installShopper` is the row for this extension_id.
 * `userShopper` is the row already carrying this user_id, if any.
 */
export function planShopperMerge(
  installShopper: ShopperRow,
  userShopper: ShopperRow | null,
  userId: string
): ShopperMergePlan {
  if (installShopper.user_id && installShopper.user_id !== userId) {
    return { action: "conflict", reason: "install_owned_by_other_user" };
  }

  if (installShopper.user_id === userId) {
    return { action: "already_linked", shopperId: installShopper.id };
  }

  if (!userShopper) {
    return { action: "attach", shopperId: installShopper.id };
  }

  if (userShopper.id === installShopper.id) {
    return { action: "already_linked", shopperId: installShopper.id };
  }

  return {
    action: "reassign",
    fromShopperId: installShopper.id,
    toShopperId: userShopper.id,
  };
}
