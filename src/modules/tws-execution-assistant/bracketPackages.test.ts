import { describe, expect, it } from "vitest";
import { groupBracketOrders } from "./bracketPackages";

describe("groupBracketOrders", () => {
  it("groups bracket package legs and leaves normal orders standalone", () => {
    const orders = [
      order(1, "ORBIT:TWS:pkg1:parent"),
      order(2, "ORBIT:TWS:pkg1:target"),
      order(3, "ORBIT:TWS:pkg1:stop"),
      order(4, null),
    ];

    const grouped = groupBracketOrders(orders, []);
    expect(grouped.packages).toHaveLength(1);
    expect(grouped.packages[0].packageId).toBe("pkg1");
    expect(grouped.packages[0].parent?.order_id).toBe(1);
    expect(grouped.packages[0].target?.order_id).toBe(2);
    expect(grouped.packages[0].exit?.order_id).toBe(3);
    expect(grouped.standaloneOrders.map((o) => o.order_id)).toEqual([4]);
  });
});

function order(order_id: number, order_ref: string | null) {
  return {
    order_id,
    conid: 270639,
    symbol: "INTC",
    side: order_id === 1 ? "BUY" : "SELL",
    quantity: 100,
    order_type: "LMT",
    lmt_price: 120,
    stop_price: null,
    status: "Submitted",
    is_unmanaged: false,
    parent_id: order_id === 1 ? null : 1,
    oca_group: null,
    order_ref,
  };
}
