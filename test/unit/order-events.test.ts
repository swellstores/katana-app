import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/order-events";
import { createMockRequest } from "../helpers/mock-request";
import { ORDER_ID, SETTINGS, appValues, jsonResponse, katanaCalls, katanaFetch, makeOrder, routeGet } from "../helpers/fixtures";

function setup({
  settings = SETTINGS as Record<string, any>,
  order = makeOrder() as Record<string, any> | null,
  eventType = "order.paid",
} = {}) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { id: ORDER_ID, $event: { type: eventType } } as any,
    appId: "katana",
    store: { id: "onixo" } as any,
    swell: {
      settings: vi.fn().mockResolvedValue({ katana: settings }),
      get: routeGet({ [`/orders/${ORDER_ID}`]: order }),
      put,
    },
  });
  return { req, put };
}

const salesOrder = { id: 900, order_no: "SW-100506", customer_id: 66, status: "NOT_SHIPPED" };
const createRoutes = {
  "GET /sales_orders": { data: [] },
  "GET /variants": { data: [{ id: 501, sku: "ETH-YIRG-1K-ESP" }] },
  "GET /customers": { data: [{ id: 66 }] },
  "POST /sales_orders": salesOrder,
  "POST /sales_order_shipping_fee": { id: 1 },
};

describe("order-events", () => {
  let fetchMock: ReturnType<typeof katanaFetch>;
  const stub = (routes: Record<string, unknown>) => {
    fetchMock = katanaFetch(routes);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    stub({});
  });

  afterEach(() => vi.restoreAllMocks());

  it("sends a paid order to Katana", async () => {
    stub(createRoutes);
    const { req, put } = setup();

    await handler(req);

    expect(katanaCalls(fetchMock)).toContain("POST /sales_orders");
    const body = JSON.parse(String((fetchMock.mock.calls.find(([, i]: any) => i?.method === "POST")![1] as RequestInit).body));
    expect(body).toMatchObject({ order_no: "SW-100506", ecommerce_store_name: "onixo", ecommerce_order_id: ORDER_ID });
    expect(put.mock.calls.at(-1)[1].$app.katana.katana_sales_order_id).toBe(900);
  });

  it("does nothing when the app is disabled", async () => {
    const { req, put } = setup({ settings: { ...SETTINGS, enabled: false } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does nothing without an API key or location", async () => {
    const { req, put } = setup({ settings: { ...SETTINGS, location_id: undefined } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does nothing when the order is not found", async () => {
    const { req, put } = setup({ order: null });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores the event that doesn't match the sync_on setting", async () => {
    const { req } = setup({ settings: { ...SETTINGS, sync_on: "submitted" }, eventType: "order.paid" });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends on submit when sync_on is submitted", async () => {
    stub(createRoutes);
    const { req } = setup({ settings: { ...SETTINGS, sync_on: "submitted" }, eventType: "order.submitted" });
    await handler(req);
    expect(katanaCalls(fetchMock)).toContain("POST /sales_orders");
  });

  it("skips orders already sent", async () => {
    const { req } = setup({ order: makeOrder({ $app: { katana: { katana_sales_order_id: 900 } } }) });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips orders without shippable items", async () => {
    const { req } = setup({ order: makeOrder({ items: [{ id: "i", delivery: null }] }) });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records missing SKUs on the order without retrying", async () => {
    stub({ "GET /sales_orders": { data: [] }, "GET /variants": { data: [] } });
    const { req, put } = setup();
    await expect(handler(req)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith(
      `/orders/${ORDER_ID}`,
      appValues({ katana_error: "Not found in Katana (by SKU): ETH-YIRG-1K-ESP" }),
    );
  });

  it("records 4xx errors without retrying", async () => {
    stub({ "GET /sales_orders": () => jsonResponse({ error: { message: "Unauthorized" } }, 401) });
    const { req, put } = setup();
    await expect(handler(req)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, appValues({ katana_error: "Katana 401: Unauthorized" }));
  });

  it("records and rethrows 5xx errors so the event is retried", async () => {
    stub({ "GET /sales_orders": () => jsonResponse({ message: "down" }, 503) });
    const { req, put } = setup();
    await expect(handler(req)).rejects.toMatchObject({ status: 502, retry: true, message: "Katana 503: down" });
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, appValues({ katana_error: "Katana 503: down" }));
  });

  it("deletes the sales order when the order is canceled", async () => {
    stub({ "GET /sales_orders/900": { id: 900, status: "NOT_SHIPPED" }, "DELETE /sales_orders/900": undefined });
    const { req, put } = setup({
      order: makeOrder({ $app: { katana: { katana_sales_order_id: 900 } } }),
      eventType: "order.canceled",
    });
    await handler(req);
    expect(katanaCalls(fetchMock)).toEqual(["GET /sales_orders/900", "DELETE /sales_orders/900"]);
    expect(put.mock.calls[0][1].$app.katana.katana_status).toBe("DELETED");
  });

  it("leaves Katana alone on cancel when on_cancel is none", async () => {
    const { req, put } = setup({
      settings: { ...SETTINGS, on_cancel: "none" },
      order: makeOrder({ $app: { katana: { katana_sales_order_id: 900 } } }),
      eventType: "order.canceled",
    });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("records a failed delete on cancel and retries 5xx errors", async () => {
    stub({ "GET /sales_orders/900": () => jsonResponse({ message: "down" }, 503) });
    const { req, put } = setup({
      order: makeOrder({ $app: { katana: { katana_sales_order_id: 900 } } }),
      eventType: "order.canceled",
    });
    await expect(handler(req)).rejects.toMatchObject({ status: 502, retry: true });
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, appValues({ katana_error: "Katana 503: down" }));
  });

  it("records a failed delete on cancel without retrying 4xx errors", async () => {
    stub({ "GET /sales_orders/900": () => jsonResponse({ message: "Forbidden" }, 403) });
    const { req, put } = setup({
      order: makeOrder({ $app: { katana: { katana_sales_order_id: 900 } } }),
      eventType: "order.canceled",
    });
    await expect(handler(req)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, appValues({ katana_error: "Katana 403: Forbidden" }));
  });
});
