import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applySalesOrder,
  cancelOrder,
  createSwellShipment,
  findSwellOrder,
  getOrder,
  resolveCustomerId,
  sendOrder,
} from "../../functions/lib/orders";
import { DuplicateSkuError, MissingSkuError } from "../../functions/lib/mapping";
import { ACCOUNT_ID, ORDER_ID, SETTINGS, appValues, jsonResponse, katanaCalls, katanaFetch, makeOrder } from "../helpers/fixtures";

function makeCtx(settings: Record<string, any> = SETTINGS) {
  const swell = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  } as any;
  return { swell, appId: "katana", storeId: "onixo", settings: settings as any, appValues };
}

function stubKatana(routes: Record<string, unknown>) {
  const fetchMock = katanaFetch(routes);
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
  return fetchMock;
}

afterEach(() => vi.restoreAllMocks());

describe("getOrder", () => {
  it("expands the account and item products/variants", async () => {
    const ctx = makeCtx();
    ctx.swell.get.mockResolvedValue({ id: ORDER_ID });
    expect(await getOrder(ctx.swell, ORDER_ID)).toEqual({ id: ORDER_ID });
    expect(ctx.swell.get).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      expand: ["account", "items.product", "items.variant"],
    });
  });
});

describe("resolveCustomerId", () => {
  it("uses the customer saved on the account", async () => {
    const fetchMock = stubKatana({});
    const order = makeOrder({ account: { id: ACCOUNT_ID, $app: { katana: { katana_customer_id: 55 } } } });
    expect(await resolveCustomerId(makeCtx(), order)).toBe(55);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds the customer by email and saves it on the account", async () => {
    stubKatana({ "GET /customers": { data: [{ id: 66 }] } });
    const ctx = makeCtx();
    expect(await resolveCustomerId(ctx, makeOrder())).toBe(66);
    expect(ctx.swell.put).toHaveBeenCalledWith(`/accounts/${ACCOUNT_ID}`, appValues({ katana_customer_id: 66 }));
  });

  it("creates the customer when none matches", async () => {
    const fetchMock = stubKatana({ "GET /customers": { data: [] }, "POST /customers": { id: 77 } });
    expect(await resolveCustomerId(makeCtx(), makeOrder())).toBe(77);
    expect(katanaCalls(fetchMock)).toEqual(["GET /customers", "POST /customers"]);
  });

  it("creates the customer without an email lookup when there is no email", async () => {
    const fetchMock = stubKatana({ "POST /customers": { id: 78 } });
    const ctx = makeCtx();
    expect(await resolveCustomerId(ctx, makeOrder({ account: undefined }))).toBe(78);
    expect(katanaCalls(fetchMock)).toEqual(["POST /customers"]);
    expect(ctx.swell.put).not.toHaveBeenCalled();
  });
});

describe("sendOrder", () => {
  const salesOrder = { id: 900, order_no: "SW-100506", customer_id: 66, status: "NOT_SHIPPED" };

  it("refuses an order whose SKU is on more than one Swell product or variant", async () => {
    const fetchMock = stubKatana({ "GET /sales_orders": { data: [] } });
    const ctx = makeCtx();
    ctx.swell.get.mockImplementation(async (url: string) =>
      url === "/products:variants"
        ? { results: [{ id: "v_a", parent_id: "p_a", sku: "ETH-YIRG-1K-ESP" }, { id: "v_b", parent_id: "p_b", sku: "ETH-YIRG-1K-ESP" }] }
        : { results: [] },
    );

    await expect(sendOrder(ctx, makeOrder())).rejects.toThrow(
      new DuplicateSkuError(["ETH-YIRG-1K-ESP"]),
    );
    expect(katanaCalls(fetchMock)).toEqual(["GET /sales_orders"]);
    expect(ctx.swell.put).not.toHaveBeenCalled();
  });

  it("creates the sales order with the shipping fee and saves it on the order", async () => {
    const fetchMock = stubKatana({
      "GET /sales_orders": { data: [] },
      "GET /variants": { data: [{ id: 501, sku: "ETH-YIRG-1K-ESP" }] },
      "GET /customers": { data: [{ id: 66 }] },
      "POST /sales_orders": salesOrder,
      "POST /sales_order_shipping_fee": { id: 1 },
    });
    const ctx = makeCtx();

    const result = await sendOrder(ctx, makeOrder());

    expect(result).toEqual({ salesOrder, created: true });
    expect(katanaCalls(fetchMock)).toEqual([
      "GET /sales_orders",
      "GET /variants",
      "GET /customers",
      "POST /sales_orders",
      "POST /sales_order_shipping_fee",
    ]);
    expect(ctx.swell.put).toHaveBeenLastCalledWith(
      `/orders/${ORDER_ID}`,
      appValues({
        katana_sales_order_id: 900,
        katana_order_no: "SW-100506",
        katana_status: "NOT_SHIPPED",
        katana_customer_id: 66,
        katana_synced_at: expect.any(String),
        katana_error: null,
      }),
    );
  });

  it("links a sales order that already exists for the Swell order", async () => {
    const fetchMock = stubKatana({ "GET /sales_orders": { data: [salesOrder] } });
    const ctx = makeCtx();

    expect(await sendOrder(ctx, makeOrder())).toEqual({ salesOrder, created: false });
    expect(katanaCalls(fetchMock)).toEqual(["GET /sales_orders"]);
    expect(ctx.swell.put.mock.calls[0][1].$app.katana.katana_sales_order_id).toBe(900);
  });

  it("throws MissingSkuError before creating anything", async () => {
    const fetchMock = stubKatana({ "GET /sales_orders": { data: [] }, "GET /variants": { data: [] } });
    await expect(sendOrder(makeCtx(), makeOrder())).rejects.toBeInstanceOf(MissingSkuError);
    expect(katanaCalls(fetchMock)).toEqual(["GET /sales_orders", "GET /variants"]);
  });

  it("keeps the sales order and records an error when the shipping fee fails", async () => {
    stubKatana({
      "GET /sales_orders": { data: [] },
      "GET /variants": { data: [{ id: 501, sku: "ETH-YIRG-1K-ESP" }] },
      "GET /customers": { data: [{ id: 66 }] },
      "POST /sales_orders": salesOrder,
      "POST /sales_order_shipping_fee": () => jsonResponse({ message: "Invalid amount" }, 422),
    });
    const ctx = makeCtx();

    await sendOrder(ctx, makeOrder());

    const saved = ctx.swell.put.mock.calls.at(-1)[1].$app.katana;
    expect(saved.katana_sales_order_id).toBe(900);
    expect(saved.katana_error).toBe("Shipping fee not added: Katana 422: Invalid amount");
  });
});

describe("cancelOrder", () => {
  const order = makeOrder({ $app: { katana: { katana_sales_order_id: 900 } } });

  it("does nothing when the order was never sent", async () => {
    const fetchMock = stubKatana({});
    expect(await cancelOrder(makeCtx(), makeOrder())).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes an open sales order", async () => {
    const fetchMock = stubKatana({
      "GET /sales_orders/900": { id: 900, status: "NOT_SHIPPED" },
      "DELETE /sales_orders/900": undefined,
    });
    const ctx = makeCtx();
    expect(await cancelOrder(ctx, order)).toBe("deleted");
    expect(katanaCalls(fetchMock)).toEqual(["GET /sales_orders/900", "DELETE /sales_orders/900"]);
    expect(ctx.swell.put.mock.calls[0][1].$app.katana).toMatchObject({ katana_status: "DELETED", katana_error: null });
  });

  it("keeps a packed or delivered sales order and records why", async () => {
    stubKatana({ "GET /sales_orders/900": { id: 900, status: "PACKED" } });
    const ctx = makeCtx();
    expect(await cancelOrder(ctx, order)).toBe("shipped");
    expect(ctx.swell.put.mock.calls[0][1].$app.katana.katana_error).toMatch(/is PACKED and was not deleted/);
  });

  it("treats a sales order already gone in Katana as deleted", async () => {
    stubKatana({ "GET /sales_orders/900": () => jsonResponse({ message: "Not found" }, 404) });
    const ctx = makeCtx();
    expect(await cancelOrder(ctx, order)).toBe("deleted");
  });

  it("rethrows other Katana errors", async () => {
    stubKatana({ "GET /sales_orders/900": () => jsonResponse({ message: "down" }, 503) });
    await expect(cancelOrder(makeCtx(), order)).rejects.toMatchObject({ status: 503 });
  });
});

describe("findSwellOrder", () => {
  it("finds the order linked to the sales order", async () => {
    const ctx = makeCtx();
    ctx.swell.get.mockResolvedValue({ results: [{ id: ORDER_ID }] });
    expect(await findSwellOrder(ctx, { id: 900 } as any)).toEqual({ id: ORDER_ID });
    expect(ctx.swell.get).toHaveBeenCalledWith("/orders", {
      where: { "$app.katana.katana_sales_order_id": 900 },
      limit: 1,
    });
  });

  it("falls back to the Swell order id stored on the sales order", async () => {
    const ctx = makeCtx();
    ctx.swell.get.mockImplementation(async (url: string) => (url === "/orders" ? { results: [] } : { id: ORDER_ID }));
    expect(await findSwellOrder(ctx, { id: 900, ecommerce_order_id: ORDER_ID } as any)).toEqual({ id: ORDER_ID });
  });

  it("returns null without a link or a valid Swell order id", async () => {
    const ctx = makeCtx();
    ctx.swell.get.mockResolvedValue({ results: [] });
    expect(await findSwellOrder(ctx, { id: 900, ecommerce_order_id: "../x" } as any)).toBeNull();
    expect(ctx.swell.get).toHaveBeenCalledTimes(1);
  });
});

describe("applySalesOrder", () => {
  const linked = (app: Record<string, unknown> = {}) =>
    makeOrder({ $app: { katana: { katana_sales_order_id: 900, ...app } } });

  function ctxWithOrder(order: any) {
    const ctx = makeCtx();
    ctx.swell.get.mockImplementation(async (url: string) => (url === "/orders" ? { results: [order] } : order));
    ctx.swell.post.mockResolvedValue({ id: "ship_1" });
    return ctx;
  }

  const delivered = { id: 900, order_no: "SW-100506", status: "DELIVERED", ecommerce_order_id: ORDER_ID };
  const fulfillment = {
    id: 1,
    tracking_number: "1Z999",
    tracking_url: "https://track/1Z999",
    tracking_carrier: "UPS",
    tracking_method: "Ground",
  };

  it("saves status and tracking and creates the shipment when delivered", async () => {
    stubKatana({ "GET /sales_order_fulfillments": { data: [fulfillment] } });
    const ctx = ctxWithOrder(linked());

    expect(await applySalesOrder(ctx, delivered as any)).toBe("updated");

    expect(ctx.swell.post).toHaveBeenCalledWith("/shipments", expect.objectContaining({
      order_id: ORDER_ID,
      items: [{ order_item_id: "item_1", product_id: "prod_1", variant_id: "var_1", quantity: 2 }],
      carrier: "UPS",
      service: "Ground",
      tracking_code: "1Z999",
      notes: "Katana sales order SW-100506: https://track/1Z999",
    }));
    expect(ctx.swell.put.mock.calls[0][1].$app.katana).toMatchObject({
      katana_status: "DELIVERED",
      katana_tracking_number: "1Z999",
      katana_tracking_url: "https://track/1Z999",
      katana_shipment_id: "ship_1",
      katana_synced_at: expect.any(String),
    });
  });

  it("does not create a second shipment and skips unchanged orders", async () => {
    stubKatana({ "GET /sales_order_fulfillments": { data: [fulfillment] } });
    const ctx = ctxWithOrder(
      linked({
        katana_order_no: "SW-100506",
        katana_status: "DELIVERED",
        katana_tracking_number: "1Z999",
        katana_tracking_url: "https://track/1Z999",
        katana_shipment_id: "ship_0",
      }),
    );
    expect(await applySalesOrder(ctx, delivered as any)).toBe("unchanged");
    expect(ctx.swell.post).not.toHaveBeenCalled();
    expect(ctx.swell.put).not.toHaveBeenCalled();
  });

  it("records packed status without reading fulfillments", async () => {
    const fetchMock = stubKatana({});
    const ctx = ctxWithOrder(linked());
    expect(await applySalesOrder(ctx, { id: 900, order_no: "SW-100506", status: "PACKED" } as any)).toBe("updated");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.swell.put.mock.calls[0][1].$app.katana.katana_status).toBe("PACKED");
  });

  it("marks sales orders deleted in Katana", async () => {
    const ctx = ctxWithOrder(linked());
    const result = await applySalesOrder(ctx, { id: 900, order_no: "SW-1", status: "NOT_SHIPPED", deleted_at: "2026-10-07" } as any);
    expect(result).toBe("updated");
    expect(ctx.swell.put.mock.calls[0][1].$app.katana.katana_status).toBe("DELETED");
  });

  it("skips the shipment when create_fulfillment is off", async () => {
    stubKatana({ "GET /sales_order_fulfillments": { data: [] } });
    const ctx = { ...ctxWithOrder(linked()), settings: { ...SETTINGS, create_fulfillment: false } as any };
    await applySalesOrder(ctx, delivered as any);
    expect(ctx.swell.post).not.toHaveBeenCalled();
  });

  it("reports sales orders without a Swell order", async () => {
    const ctx = makeCtx();
    ctx.swell.get.mockResolvedValue({ results: [] });
    expect(await applySalesOrder(ctx, { id: 1, order_no: "SO-1", status: "PACKED" } as any)).toBe("not_found");
  });
});

describe("createSwellShipment", () => {
  it("returns null when nothing is left to ship", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    const order = makeOrder();
    order.items[0].quantity_shipment_deliverable = 0;
    ctx.swell.get.mockResolvedValue(order);
    expect(await createSwellShipment(ctx.swell, ORDER_ID, { id: 900, order_no: "SW-1" } as any)).toBeNull();
    expect(ctx.swell.post).not.toHaveBeenCalled();
  });

  it("does not ship digital items", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.swell.get.mockResolvedValue(
      makeOrder({ items: [{ id: "item_d", delivery: null, quantity: 1, product: { stock_tracking: true } }] }),
    );
    expect(await createSwellShipment(ctx.swell, ORDER_ID, { id: 900, order_no: "SW-1" } as any)).toBeNull();
    expect(ctx.swell.post).not.toHaveBeenCalled();
  });

  it("uses the sales order tracking when there is no fulfillment", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.swell.get.mockResolvedValue(makeOrder());
    ctx.swell.post.mockResolvedValue({ id: "ship_2" });
    const id = await createSwellShipment(ctx.swell, ORDER_ID, {
      id: 900,
      order_no: "SW-1",
      tracking_number: "T1",
      tracking_number_url: "https://t/1",
    } as any);
    expect(id).toBe("ship_2");
    expect(ctx.swell.post.mock.calls[0][1]).toMatchObject({ tracking_code: "T1", notes: "Katana sales order SW-1: https://t/1" });
  });
});
