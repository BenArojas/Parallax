import { describe, expect, it } from "vitest";
import { groupScaleOutOrders } from "./scaleOutPackages";
import type { ReconciliationSnapshot } from "./api";

describe("groupScaleOutOrders", () => {
  it("groups scale-out package legs and leaves normal orders standalone", () => {
    const recon: ReconciliationSnapshot = {
      position_count: 0,
      open_order_count: 3,
      unmanaged_order_count: 0,
      positions: [],
      package_warnings: [],
      open_orders: [
        order(1, "ORBIT:TWS:pkg1:lot0_entry"),
        order(2, "ORBIT:TWS:pkg1:lot0_target"),
        order(3, null),
      ],
    };

    const grouped = groupScaleOutOrders(recon);
    expect(grouped.packages).toHaveLength(1);
    expect(grouped.packages[0].packageId).toBe("pkg1");
    expect(grouped.packages[0].lots[0].entry?.order_id).toBe(1);
    expect(grouped.packages[0].lots[0].exits.map((o) => o.order_id)).toEqual([2]);
    expect(grouped.standaloneOrders.map((o) => o.order_id)).toEqual([3]);
  });
});

function order(order_id: number, order_ref: string | null) {
  return {
    order_id,
    conid: 270639,
    symbol: "INTC",
    side: order_id === 1 ? "BUY" : "SELL",
    quantity: 5,
    order_type: "LMT",
    lmt_price: 125,
    stop_price: null,
    status: "Submitted",
    is_unmanaged: false,
    parent_id: null,
    oca_group: null,
    order_ref,
  };
}
