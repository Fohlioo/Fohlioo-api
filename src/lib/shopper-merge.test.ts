import { describe, expect, test } from "vitest";
import { planShopperMerge, type ShopperRow } from "./shopper-merge";

function shopper(overrides: Partial<ShopperRow>): ShopperRow {
  return {
    id: "shopper-a",
    extension_id: "ext-1",
    user_id: null,
    event_count: 4,
    ...overrides,
  };
}

describe("planShopperMerge", () => {
  test("attaches user_id when this install is unsigned and the user has no shopper", () => {
    expect(planShopperMerge(shopper({}), null, "user-1")).toEqual({
      action: "attach",
      shopperId: "shopper-a",
    });
  });

  test("is a no-op when this install is already linked to the same user", () => {
    expect(
      planShopperMerge(shopper({ user_id: "user-1" }), shopper({ user_id: "user-1" }), "user-1")
    ).toEqual({ action: "already_linked", shopperId: "shopper-a" });
  });

  test("conflicts when this install belongs to a different user", () => {
    expect(
      planShopperMerge(shopper({ user_id: "user-other" }), null, "user-1")
    ).toEqual({ action: "conflict", reason: "install_owned_by_other_user" });
  });

  test("reassigns a second install onto the user's existing shopper", () => {
    const install = shopper({
      id: "shopper-b",
      extension_id: "ext-2",
      event_count: 3,
    });
    const existing = shopper({
      id: "shopper-a",
      extension_id: "ext-1",
      user_id: "user-1",
      event_count: 10,
    });
    expect(planShopperMerge(install, existing, "user-1")).toEqual({
      action: "reassign",
      fromShopperId: "shopper-b",
      toShopperId: "shopper-a",
    });
  });
});
