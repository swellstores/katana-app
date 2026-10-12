import { describe, it, expect } from "vitest";
import { createSwellClient } from "../helpers/swell-client";
import { ordersQuery } from "../../functions/lib/jobs";

// Read-only checks against the logged-in test store (uses swell-cli auth). Run after `swell app push`.
describe("deployed app (read-only)", () => {
  const swell = createSwellClient();

  it("reads the app settings with their defaults", async () => {
    const settings = await swell.settings("katana");
    expect(settings).toBeTypeOf("object");
    expect(["paid", "submitted"]).toContain(settings?.katana?.sync_on);
    expect(["available", "in_stock"]).toContain(settings?.katana?.stock_quantity);
  });

  it("queries orders by the Katana sales order id the 5-minute check uses", async () => {
    const result = await swell.get("/orders", {
      where: { "$app.katana.katana_sales_order_id": -1 },
      limit: 1,
    });
    expect(result?.results).toEqual([]);
  });

  it("lists product variants across products by SKU, as the stock sync does", async () => {
    const result = await swell.get("/products:variants", {
      where: { sku: { $in: ["__katana_test_none__"] } },
      fields: "id,parent_id,sku,stock_level",
      limit: 1,
    });
    expect(result?.results).toEqual([]);
  });

  it("selects only paid, uncanceled orders without a sales order for an order sync", async () => {
    const ctx = { swell, appId: "katana", storeId: "", settings: { sync_on: "paid" }, appValues: (v: SwellData) => v } as any;
    const query = ordersQuery(ctx, { id: "x", type: "orders", status: "running" }, 100);
    const result = await swell.get("/orders", { ...query, expand: undefined, fields: "id,paid,canceled,$app" });
    const all = await swell.get("/orders", { limit: 1 });
    expect(result?.count).toBeLessThan(all?.count);
    for (const order of result?.results || []) {
      expect(order.paid).toBe(true);
      expect(order.canceled).not.toBe(true);
      expect(order.$app?.katana?.katana_sales_order_id ?? null).toBeNull();
    }
    const ids = (result?.results || []).map((o: any) => o.id);
    expect(ids).toEqual([...ids].sort());
  });
});
