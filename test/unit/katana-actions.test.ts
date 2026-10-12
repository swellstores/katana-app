import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/katana-actions";
import { createMockRequest } from "../helpers/mock-request";
import { ORDER_ID, SETTINGS, jsonResponse, katanaCalls, katanaFetch, makeOrder, routeGet } from "../helpers/fixtures";

function setup({
  action = "test_connection",
  settings = SETTINGS as Record<string, any>,
  data = {} as Record<string, any>,
  order = makeOrder() as Record<string, any> | null,
  active = [] as Record<string, any>[],
} = {}) {
  const put = vi.fn().mockResolvedValue({});
  const post = vi.fn(async (_url: string, body: any) => ({ id: "job_new", ...body }));
  const req = createMockRequest({
    data: { ...data, $action: { id: action, source: "settings", ...(data.$action || {}) } } as any,
    appId: "katana",
    store: { id: "onixo" } as any,
    swell: {
      settings: vi.fn().mockResolvedValue({ katana: settings }),
      get: routeGet({
        [`/orders/${ORDER_ID}`]: order,
        "/products": { results: [] },
        "/products:variants": { results: [] },
        "/pulls": { results: [] },
        "/syncs": { results: active },
      }),
      put,
      post,
    },
  });
  return { req, put, post };
}

describe("katana-actions", () => {
  let fetchMock: ReturnType<typeof katanaFetch>;
  const stub = (routes: Record<string, unknown>) => {
    fetchMock = katanaFetch(routes);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
  };

  beforeEach(() => stub({}));
  afterEach(() => vi.restoreAllMocks());

  it("asks for the API key first", async () => {
    const { req } = setup({ settings: { api_key: "" } });
    expect(await handler(req)).toEqual({ message: "Enter the Katana API key and save the settings first." });
  });

  it("rejects unknown actions", async () => {
    const { req } = setup({ action: "nope" });
    await expect(handler(req)).rejects.toMatchObject({ status: 400 });
  });

  describe("test_connection", () => {
    const routes = {
      "GET /locations": { data: [{ id: 7, name: "Main" }, { id: 8, name: "Store", sales_allowed: false }] },
      "GET /tax_rates": { data: [{ id: 3, display_name: "0% Exempt" }] },
    };

    it("lists locations and tax rates", async () => {
      stub(routes);
      const { req } = setup();
      expect(await handler(req)).toEqual({
        message: "Connected to Katana. Locations: 7 = Main, 8 = Store (sales not allowed). Tax rates: 3 = 0% Exempt.",
      });
    });

    it("points out unknown or missing IDs", async () => {
      stub(routes);
      const unknown = setup({ settings: { ...SETTINGS, location_id: 99, tax_rate_id: 98 } });
      const result = (await handler(unknown.req)) as { message: string };
      expect(result.message).toContain("Location ID 99 does not exist in Katana.");
      expect(result.message).toContain("Tax rate ID 98 does not exist in Katana.");

      const missing = setup({ settings: { ...SETTINGS, location_id: undefined } });
      expect(((await handler(missing.req)) as { message: string }).message).toContain("Location ID is not set.");
    });

    it("surfaces Katana errors", async () => {
      stub({ "GET /locations": () => jsonResponse({ error: { message: "Unauthorized" } }, 401), "GET /tax_rates": { data: [] } });
      const { req } = setup();
      await expect(handler(req)).rejects.toMatchObject({ status: 401 });
    });
  });

  describe("check_now", () => {
    it("checks Katana for changes and reports the result", async () => {
      stub({ "GET /sales_orders": { data: [] }, "GET /inventory_movements": { data: [] } });
      const { req, put } = setup({
        action: "check_now",
        settings: { ...SETTINGS, orders_checked_at: "2026-10-07T10:00:00.000Z", stock_checked_at: "2026-10-07T10:30:00.000Z" },
      });
      expect(await handler(req)).toEqual({
        message:
          "Sales orders changed since 2026-10-07T09:59:00.000Z: 0 Swell orders updated, 0 sales orders without a Swell order. " +
          "Stock changed since 2026-10-07T10:29:00.000Z: 0 Swell stock levels changed, 0 moved SKUs not in Swell.",
      });
      expect(put).toHaveBeenCalledWith("/settings/katana", { katana: { orders_checked_at: expect.any(String) } });
    });

    it("needs a location", async () => {
      const { req } = setup({ action: "check_now", settings: { ...SETTINGS, location_id: undefined } });
      expect(await handler(req)).toEqual({ message: "Set the API key and Location ID first." });
    });
  });

  describe("sync_inventory", () => {
    it("starts a stock sync job", async () => {
      const { req, post } = setup({ action: "sync_inventory" });
      expect(await handler(req)).toEqual({ message: "Stock sync started. Follow it under Katana syncs in the dashboard sidebar." });
      expect(post).toHaveBeenCalledWith("/syncs", { type: "inventory", status: "pending", trigger: "manual" });
    });

    it("points to the active job instead of starting another", async () => {
      const { req, post } = setup({ action: "sync_inventory", active: [{ id: "busy", status: "waiting" }] });
      expect(await handler(req)).toEqual({ message: "A stock sync is already waiting. Follow it under Katana syncs in the dashboard sidebar." });
      expect(post).not.toHaveBeenCalled();
    });

    it("needs a location and inventory sync on", async () => {
      const noLocation = setup({ action: "sync_inventory", settings: { ...SETTINGS, location_id: undefined } });
      expect(await handler(noLocation.req)).toEqual({ message: "Set the API key and Location ID first." });
      const off = setup({ action: "sync_inventory", settings: { ...SETTINGS, sync_inventory: false } });
      expect(await handler(off.req)).toEqual({ message: 'Turn on "Sync inventory from Katana" in the app settings first.' });
    });
  });

  describe("send_orders", () => {
    it("starts an order sync job from a date", async () => {
      const { req, post } = setup({ action: "send_orders", data: { date_from: "2026-09-01T00:00:00.000Z" } });
      expect(await handler(req)).toEqual({ message: "Order sync started. Follow it under Katana syncs in the dashboard sidebar." });
      expect(post).toHaveBeenCalledWith("/syncs", { type: "orders", status: "pending", trigger: "manual", date_from: "2026-09-01T00:00:00.000Z" });
    });

    it("starts without a date and rejects invalid dates", async () => {
      const { req, post } = setup({ action: "send_orders" });
      await handler(req);
      expect(post).toHaveBeenCalledWith("/syncs", { type: "orders", status: "pending", trigger: "manual" });
      const bad = setup({ action: "send_orders", data: { date_from: "soon" } });
      await expect(handler(bad.req)).rejects.toMatchObject({ status: 400 });
    });

    it("needs credentials", async () => {
      const { req } = setup({ action: "send_orders", settings: { api_key: "k" } });
      expect(await handler(req)).toEqual({ message: "Set the API key and Location ID first." });
    });
  });

  describe("send_products", () => {
    it("starts a product export job", async () => {
      const { req, post } = setup({ action: "send_products" });
      expect(await handler(req)).toEqual({ message: "Product export started. Follow it under Katana syncs in the dashboard sidebar." });
      expect(post).toHaveBeenCalledWith("/syncs", { type: "products", status: "pending", trigger: "manual" });
    });

    it("needs credentials", async () => {
      const { req } = setup({ action: "send_products", settings: { api_key: "k" } });
      expect(await handler(req)).toEqual({ message: "Set the API key and Location ID first." });
    });
  });

  describe("send_order", () => {
    const sendData = { $action: { id: "send_order", source: "record", record_id: ORDER_ID } };

    it("creates the sales order for the order", async () => {
      stub({
        "GET /sales_orders": { data: [] },
        "GET /variants": { data: [{ id: 501, sku: "ETH-YIRG-1K-ESP" }] },
        "GET /customers": { data: [{ id: 66 }] },
        "POST /sales_orders": { id: 900, order_no: "SW-100506", status: "NOT_SHIPPED" },
        "POST /sales_order_shipping_fee": { id: 1 },
      });
      const { req } = setup({ action: "send_order", data: sendData });
      expect(await handler(req)).toEqual({ message: "Created Katana sales order SW-100506." });
    });

    it("links an existing sales order", async () => {
      stub({ "GET /sales_orders": { data: [{ id: 900, order_no: "SW-100506", status: "PACKED" }] } });
      const { req } = setup({ action: "send_order", data: sendData });
      expect(await handler(req)).toEqual({ message: "Linked existing Katana sales order SW-100506." });
    });

    it("does not send an order twice", async () => {
      const order = makeOrder({ $app: { katana: { katana_sales_order_id: 900, katana_order_no: "SW-100506" } } });
      const { req } = setup({ action: "send_order", data: sendData, order });
      expect(await handler(req)).toEqual({ message: "Already in Katana as sales order SW-100506." });
    });

    it("skips orders with nothing to ship", async () => {
      const { req } = setup({ action: "send_order", data: sendData, order: makeOrder({ items: [] }) });
      expect(await handler(req)).toEqual({ message: "This order has no items for Katana, so nothing was sent." });
    });

    it("shows and records the error", async () => {
      stub({ "GET /sales_orders": { data: [] }, "GET /variants": { data: [] } });
      const { req, put } = setup({ action: "send_order", data: sendData });
      expect(await handler(req)).toEqual({ message: "Not sent: Not found in Katana (by SKU): ETH-YIRG-1K-ESP" });
      expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
        $app: { katana: { katana_error: "Not found in Katana (by SKU): ETH-YIRG-1K-ESP" } },
      });
    });

    it("validates the record id and finds the order", async () => {
      const bad = setup({ action: "send_order", data: { $action: { id: "send_order", record_id: "../x" } } });
      await expect(handler(bad.req)).rejects.toMatchObject({ status: 400 });

      const missing = setup({ action: "send_order", data: sendData, order: null });
      await expect(handler(missing.req)).rejects.toMatchObject({ status: 404 });
    });

    it("needs credentials", async () => {
      const { req } = setup({ action: "send_order", data: sendData, settings: { api_key: "k" } });
      expect(await handler(req)).toEqual({ message: "Set the API key and Location ID first." });
    });
  });
});
