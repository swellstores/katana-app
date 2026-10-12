import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  activeJob,
  inventoryStep,
  ordersQuery,
  ordersStep,
  productsQuery,
  productsStep,
  retryDelaySeconds,
  runStep,
  shouldRun,
  startJob,
  type Job,
} from "../../functions/lib/jobs";
import { KatanaError } from "../../functions/lib/katana";
import { ORDER_ID, SETTINGS, appValues, jsonResponse, katanaCalls, katanaFetch, makeOrder, params } from "../helpers/fixtures";

const ctx = (swell: any, settings: Record<string, any> = SETTINGS) => ({
  swell,
  appId: "katana",
  storeId: "onixo",
  settings: settings as any,
  appValues,
});

const job = (overrides: Partial<Job> = {}): Job => ({ id: "job_1", type: "inventory", status: "running", ...overrides });

const row = (sku: string, inStock: number) => ({
  variant_id: 1,
  location_id: 7,
  quantity_in_stock: String(inStock),
  quantity_committed: "0",
  variant: { id: 1, sku },
});

// a simple product SIMPLE with 4 in stock and tracking on
function stockSwell() {
  const get = vi.fn(async (url: string, query: any) => {
    if (url === "/products") {
      return { results: [{ id: "p_simple", name: "Mug", sku: "SIMPLE", stock_level: 4, stock_tracking: true }].filter((p) => query.where.sku.$in.includes(p.sku)) };
    }
    if (url === "/products:variants") {
      return { results: [] };
    }
    return null;
  });
  return { get, post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) } as any;
}

let fetchMock: ReturnType<typeof katanaFetch>;
const stub = (routes: Record<string, unknown>) => {
  fetchMock = katanaFetch(routes);
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
};

beforeEach(() => stub({}));
afterEach(() => vi.restoreAllMocks());

describe("retryDelaySeconds", () => {
  it("waits a minute after a rate limit", () => {
    expect(retryDelaySeconds(new KatanaError("slow down", 429), 5)).toBe(60);
  });

  it("backs off exponentially up to 30 minutes", () => {
    expect([1, 2, 3, 6, 10].map((n) => retryDelaySeconds(new KatanaError("down", 503), n))).toEqual([60, 120, 240, 1800, 1800]);
  });
});

describe("shouldRun", () => {
  it("runs on create, on a recorded step and when set back to pending", () => {
    expect(shouldRun({ $event: { type: "sync.created" } })).toBe(true);
    expect(shouldRun({ $event: { type: "sync.updated", data: { pages: 2 } } })).toBe(true);
    expect(shouldRun({ $event: { type: "sync.updated", data: { status: "pending" } } })).toBe(true);
  });

  it("ignores other edits", () => {
    expect(shouldRun({ $event: { type: "sync.updated", data: { status: "canceled" } } })).toBe(false);
    expect(shouldRun({ $event: { type: "sync.updated", data: { last_error: null } } })).toBe(false);
  });
});

describe("activeJob / startJob", () => {
  it("finds the active job of a type", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ results: [job()] }) } as any;
    expect(await activeJob(swell, "inventory")).toEqual(job());
    expect(swell.get).toHaveBeenCalledWith("/syncs", {
      where: { type: "inventory", status: { $in: ["pending", "running", "waiting"] } },
      sort: "date_created asc",
      limit: 1,
    });
  });

  it("starts a job when none is active", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ results: [] }), post: vi.fn().mockResolvedValue({ id: "new" }) } as any;
    expect(await startJob(swell, "orders", { date_from: "2026-01-01" })).toEqual({ job: { id: "new" }, started: true });
    expect(swell.post).toHaveBeenCalledWith("/syncs", { type: "orders", status: "pending", trigger: "manual", date_from: "2026-01-01" });
  });

  it("returns the active job instead of starting another", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ results: [job()] }), post: vi.fn() } as any;
    expect(await startJob(swell, "inventory")).toEqual({ job: job(), started: false });
    expect(swell.post).not.toHaveBeenCalled();
  });
});

describe("inventoryStep", () => {
  it("applies a full page and moves to the next", async () => {
    let query: Record<string, string> = {};
    stub({
      "GET /inventory": (url: URL) => {
        query = params(url);
        return { data: [row("SIMPLE", 10), row("OTHER", 1)] };
      },
    });
    const swell = stockSwell();

    const { update } = await inventoryStep(ctx(swell, { ...SETTINGS, sync_page_size: 2 }), job({ page: 3, pages: 2, changed: 5 }), Infinity);

    expect(query).toMatchObject({ page: "3", limit: "2", location_id: "7", extend: "variant" });
    expect(update).toEqual({
      pages: 3,
      checked: 2,
      changed: 6,
      skipped: 0,
      not_found: 1,
      report_rows: 1,
      last_error: null,
      page: 4,
      $push: { report: { $each: [{ product: "Mug", variant: null, change: 6, sku: "SIMPLE" }] } },
    });
    expect(swell.post).toHaveBeenCalledWith("/products:stock", expect.objectContaining({ parent_id: "p_simple", quantity: 6 }));
  });

  it("records SKUs used by more than one Swell product or variant without changing them", async () => {
    stub({ "GET /inventory": { data: [row("DUP", 3), row("SIMPLE", 4)] } });
    const swell = stockSwell();
    swell.get.mockImplementation(async (url: string, query: any) => {
      if (url === "/products:variants") return { results: [{ id: "v_a", parent_id: "p_a", sku: "DUP" }, { id: "v_b", parent_id: "p_b", sku: "DUP" }] };
      if (url === "/products" && query?.where?.id) return { results: [] };
      if (url === "/products") return { results: [] };
      return null;
    });

    const { update } = await inventoryStep(ctx(swell), job({ duplicate_skus: ["OLD"] }), Infinity);

    expect(update).toMatchObject({ checked: 2, changed: 0, not_found: 1, duplicate_skus: ["OLD", "DUP"] });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("completes on a short page", async () => {
    stub({ "GET /inventory": { data: [row("SIMPLE", 4)] } });
    const { update } = await inventoryStep(ctx(stockSwell()), job(), Infinity);
    expect(update).toMatchObject({ page: 1, status: "completed", checked: 1, changed: 0 });
  });

  it("reads the same page again when time runs out", async () => {
    stub({ "GET /inventory": { data: [row("SIMPLE", 10)] } });
    const swell = stockSwell();
    const { update } = await inventoryStep(ctx(swell), job({ page: 2 }), Date.now() - 1);
    expect(update).toMatchObject({ page: 2, pages: 1 });
    expect(update.status).toBeUndefined();
    expect(swell.post).not.toHaveBeenCalled();
  });
});

describe("ordersQuery", () => {
  it("selects paid, uncanceled, undelivered orders not in Katana, after the cursor", () => {
    const query = ordersQuery(ctx({}), job({ type: "orders", date_from: "2026-01-01", last_id: "abc" }), 25);
    expect(query).toEqual({
      where: {
        canceled: { $ne: true },
        delivered: { $ne: true },
        "$app.katana.katana_sales_order_id": null,
        paid: true,
        date_created: { $gte: "2026-01-01" },
        id: { $gt: "abc" },
      },
      sort: "id asc",
      limit: 25,
      expand: ["account", "items.product", "items.variant"],
    });
  });

  it("includes unpaid orders when orders are sent on submit", () => {
    const query = ordersQuery(ctx({}, { ...SETTINGS, sync_on: "submitted" }), job({ type: "orders" }), 50);
    expect(query.where).not.toHaveProperty("paid");
    expect(query.where).not.toHaveProperty("id");
  });
});

describe("ordersStep", () => {
  const createRoutes = {
    "GET /sales_orders": { data: [] },
    "GET /variants": { data: [{ id: 501, sku: "ETH-YIRG-1K-ESP" }] },
    "GET /customers": { data: [{ id: 66 }] },
    "POST /sales_orders": { id: 900, order_no: "SW-100506", customer_id: 66, status: "NOT_SHIPPED" },
    "POST /sales_order_shipping_fee": { id: 1 },
  };
  const orderSwell = (orders: any[], count = orders.length) =>
    ({
      get: vi.fn().mockResolvedValue({ results: orders, count }),
      put: vi.fn().mockResolvedValue({}),
    }) as any;
  const second = "6ac623e9bf440b0012d666c0";

  it("sends orders, skips those with nothing to ship and completes on a short page", async () => {
    stub(createRoutes);
    const swell = orderSwell([makeOrder(), makeOrder({ id: second, items: [] })]);

    const { update, error } = await ordersStep(ctx(swell), job({ type: "orders" }), Infinity);

    expect(error).toBeUndefined();
    expect(update).toEqual({
      pages: 1,
      last_id: second,
      checked: 2,
      changed: 1,
      skipped: 1,
      failed: 0,
      last_error: null,
      total: 2,
      status: "completed",
    });
    expect(katanaCalls(fetchMock)).toContain("POST /sales_orders");
  });

  it("fails orders with a SKU used by more than one Swell product or variant, without retrying", async () => {
    stub(createRoutes);
    const swell = {
      get: vi.fn(async (url: string) =>
        url === "/orders"
          ? { results: [makeOrder()], count: 1 }
          : url === "/products:variants"
            ? { results: [{ id: "v_a", parent_id: "p_a", sku: "ETH-YIRG-1K-ESP" }, { id: "v_b", parent_id: "p_b", sku: "ETH-YIRG-1K-ESP" }] }
            : { results: [] },
      ),
      put: vi.fn().mockResolvedValue({}),
    } as any;

    const { update, error } = await ordersStep(ctx(swell), job({ type: "orders" }), Infinity);

    expect(error).toBeUndefined();
    expect(update).toMatchObject({ failed: 1, changed: 0, status: "completed" });
    expect(swell.put).toHaveBeenCalledWith(
      `/orders/${ORDER_ID}`,
      appValues({ katana_error: "Same SKU on more than one Swell product or variant: ETH-YIRG-1K-ESP" }),
    );
    expect(katanaCalls(fetchMock)).not.toContain("POST /sales_orders");
  });

  it("records orders Katana rejects and carries on", async () => {
    stub({ "GET /sales_orders": { data: [] }, "GET /variants": { data: [] } });
    const swell = orderSwell([makeOrder()], 10);

    const { update } = await ordersStep(ctx(swell, { ...SETTINGS, sync_page_size: 1 }), job({ type: "orders", last_id: "a", failed: 2 }), Infinity);

    expect(update).toMatchObject({ failed: 3, checked: 1, last_id: ORDER_ID, last_error: "Order 100506: Not found in Katana (by SKU): ETH-YIRG-1K-ESP" });
    expect(update).not.toHaveProperty("total");
    expect(update).not.toHaveProperty("status");
    expect(swell.put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, appValues({ katana_error: "Not found in Katana (by SKU): ETH-YIRG-1K-ESP" }));
  });

  it("stops at a retryable error with the progress so far", async () => {
    let calls = 0;
    stub({
      ...createRoutes,
      "GET /sales_orders": () => (++calls === 1 ? { data: [] } : jsonResponse({ message: "down" }, 503)),
    });
    const swell = orderSwell([makeOrder(), makeOrder({ id: second })]);

    const { update, error } = await ordersStep(ctx(swell), job({ type: "orders" }), Infinity);

    expect(error).toBeInstanceOf(KatanaError);
    expect(update).toMatchObject({ last_id: ORDER_ID, checked: 1, changed: 1 });
    expect(update).not.toHaveProperty("status");
  });

  it("stops when time runs out", async () => {
    const swell = orderSwell([makeOrder()]);
    const { update } = await ordersStep(ctx(swell), job({ type: "orders", last_id: "x" }), Date.now() - 1);
    expect(update).toMatchObject({ last_id: "x", checked: 0 });
    expect(update).not.toHaveProperty("status");
  });
});

describe("productsQuery", () => {
  it("selects products with stock tracking on, after the cursor", () => {
    expect(productsQuery(job({ type: "products", last_id: "abc" }), 20)).toEqual({
      where: { stock_tracking: true, id: { $gt: "abc" } },
      sort: "id asc",
      limit: 20,
      fields: "id,name,sku,price,cost,stock_level,stock_tracking,options",
    });
    expect(productsQuery(job({ type: "products" }), 20).where).toEqual({ stock_tracking: true });
  });
});

describe("productsStep", () => {
  const mug = { id: "p1", name: "Mug", sku: "MUG", price: 12, stock_level: 7, stock_tracking: true };
  const bare = { id: "p2", name: "No SKU", stock_level: 1, stock_tracking: true };
  const shirt = {
    id: "p3",
    name: "Shirt",
    stock_level: 0,
    stock_tracking: true,
    options: [{ id: "o", name: "Size", variant: true, values: [{ id: "s", name: "S" }] }],
  };
  const productSwell = (products: any[], variants: any[] = [], count = products.length) =>
    ({
      get: vi.fn(async (url: string) =>
        url === "/products" ? { results: products, count } : url === "/products:variants" ? { results: variants } : null,
      ),
      put: vi.fn().mockResolvedValue({}),
    }) as any;

  it("creates Katana products, sets starting stock and completes on a short page", async () => {
    let lookups = 0;
    stub({
      "GET /variants": () => (++lookups === 1 ? { data: [] } : { data: [{ id: 41, sku: lookups === 2 ? "MUG" : "SHIRT-S", product_id: 9 }] }),
      "POST /products": { id: 9 },
      "GET /inventory": { data: [] },
      "POST /stock_adjustments": { id: 1 },
    });
    const swell = productSwell([mug, bare, shirt], [{ id: "v", parent_id: "p3", sku: "SHIRT-S", stock_level: 0, option_value_ids: ["s"] }]);

    const { update, error } = await productsStep(ctx(swell), job({ type: "products" }), Infinity);

    expect(error).toBeUndefined();
    expect(update).toEqual({
      pages: 1,
      last_id: "p3",
      checked: 3,
      changed: 2,
      skipped: 1,
      failed: 0,
      adjusted: 1,
      last_error: null,
      total: 3,
      status: "completed",
    });
    expect(swell.get).toHaveBeenCalledWith("/products:variants", expect.objectContaining({ where: { parent_id: { $in: ["p3"] } } }));
    expect(swell.put).toHaveBeenCalledWith("/products/p1", appValues({ katana_error: null }));
  });

  it("fails products whose SKU another Swell product or variant also uses, without creating them", async () => {
    let lookups = 0;
    stub({
      "GET /variants": () => (++lookups === 1 ? { data: [] } : { data: [{ id: 41, sku: "MUG", product_id: 9 }] }),
      "POST /products": { id: 9 },
      "GET /inventory": { data: [] },
      "POST /stock_adjustments": { id: 1 },
    });
    const shirt2 = { ...shirt, id: "p4", name: "Shirt 2" };
    const swell = productSwell(
      [mug, shirt, shirt2],
      [
        { id: "v1", parent_id: "p3", sku: "SHIRT-S", stock_level: 0, option_value_ids: ["s"] },
        { id: "v2", parent_id: "p4", sku: "SHIRT-S", stock_level: 0, option_value_ids: ["s"] },
      ],
    );

    const { update } = await productsStep(ctx(swell), job({ type: "products" }), Infinity);

    expect(update).toMatchObject({ checked: 3, changed: 1, failed: 2, last_id: "p4" });
    expect(update.last_error).toBe("Product Shirt 2: Same SKU on more than one Swell product or variant: SHIRT-S");
    expect(swell.put).toHaveBeenCalledWith(
      "/products/p3",
      appValues({ katana_error: "Product export: Same SKU on more than one Swell product or variant: SHIRT-S" }),
    );
    expect(katanaCalls(fetchMock).filter((call) => call === "POST /products")).toHaveLength(1);
  });

  it("records products Katana rejects and carries on", async () => {
    stub({ "GET /variants": { data: [] }, "POST /products": () => jsonResponse({ message: "Validation failed", details: [{ path: ".name", message: "too long" }] }, 422) });
    const swell = productSwell([mug], [], 5);

    const { update } = await productsStep(ctx(swell, { ...SETTINGS, sync_page_size: 1 }), job({ type: "products", last_id: "p0", failed: 1 }), Infinity);

    expect(update).toMatchObject({ failed: 2, checked: 1, last_id: "p1", last_error: "Product Mug: Katana 422: Validation failed: .name too long" });
    expect(update).not.toHaveProperty("status");
    expect(update).not.toHaveProperty("total");
    expect(swell.put).toHaveBeenCalledWith("/products/p1", appValues({ katana_error: "Product export: Katana 422: Validation failed: .name too long" }));
  });

  it("stops at a retryable error with the progress so far", async () => {
    stub({ "GET /variants": { data: [] }, "POST /products": () => jsonResponse({ message: "busy" }, 429) });
    const swell = productSwell([mug]);
    const { update, error } = await productsStep(ctx(swell), job({ type: "products" }), Infinity);
    expect(error).toBeInstanceOf(KatanaError);
    expect(update).toMatchObject({ checked: 0, last_id: null });
    expect(update).not.toHaveProperty("status");
  });

  it("stops when time runs out", async () => {
    stub({ "GET /variants": { data: [] } });
    const { update } = await productsStep(ctx(productSwell([mug])), job({ type: "products", last_id: "p0" }), Date.now() - 1);
    expect(update).toMatchObject({ last_id: "p0", checked: 0 });
    expect(update).not.toHaveProperty("status");
  });
});

describe("runStep", () => {
  it("rejects unknown job types", async () => {
    await expect(runStep(ctx({}), job({ type: "nope" as any }), Infinity)).rejects.toThrow("Unknown sync type: nope");
  });
});
