import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FIRST_LOOKBACK_MS,
  MOVEMENT_PAGE,
  SALES_ORDER_PAGE,
  checkCursor,
  describeChecks,
  latestPull,
  pullSource,
  pullSources,
  runChecks,
  type PullResult,
} from "../../functions/lib/pull";
import { ORDER_ID, SETTINGS, appValues, jsonResponse, katanaCalls, katanaFetch, makeOrder, params } from "../helpers/fixtures";

const T = Date.parse("2026-10-07T12:00:00.000Z");
const now = () => T;

const salesOrder = (overrides: Record<string, any> = {}) => ({
  id: 900,
  order_no: "SW-100506",
  customer_id: 66,
  status: "PACKED",
  ecommerce_order_id: ORDER_ID,
  ...overrides,
});

// a Swell order linked to sales order 900 (NOT_SHIPPED), and a simple product SIMPLE with 4 in stock
function makeSwell({ latest = undefined as any, order = makeOrder({ $app: { katana: { katana_sales_order_id: 900, katana_order_no: "SW-100506", katana_status: "NOT_SHIPPED" } } }) as Record<string, any> | null } = {}) {
  const get = vi.fn(async (url: string, query: any) => {
    if (url === "/pulls") return { results: latest ? [latest] : [] };
    if (url === "/orders") {
      const linked = order?.$app?.katana?.katana_sales_order_id;
      return { results: order && query?.where?.["$app.katana.katana_sales_order_id"] === linked ? [order] : [] };
    }
    if (url.startsWith("/orders/")) return url === `/orders/${order?.id}` ? order : null;
    if (url === "/products") {
      return { results: [{ id: "p_simple", sku: "SIMPLE", stock_level: 4, stock_tracking: true }].filter((p) => query.where.sku.$in.includes(p.sku)) };
    }
    if (url === "/products:variants") return { results: [] };
    return null;
  });
  const post = vi.fn(async (url: string, body: any) => (url === "/pulls" ? { id: "pull_new", ...body } : {}));
  return { get, post, put: vi.fn().mockResolvedValue({}) } as any;
}

const ctx = (swell: any, settings: Record<string, any> = SETTINGS) => ({
  swell,
  appId: "katana",
  storeId: "onixo",
  settings: settings as any,
  appValues,
});

let fetchMock: ReturnType<typeof katanaFetch>;
const stub = (routes: Record<string, unknown>) => {
  fetchMock = katanaFetch(routes);
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  stub({});
});
afterEach(() => vi.restoreAllMocks());

const settingsPut = (swell: any) => swell.put.mock.calls.filter(([url]: [string]) => url === "/settings/katana");

describe("pullSources", () => {
  it("checks stock only while inventory sync is on", () => {
    expect(pullSources(SETTINGS as any)).toEqual(["sales_orders", "inventory"]);
    expect(pullSources({ ...SETTINGS, sync_inventory: false } as any)).toEqual(["sales_orders"]);
  });
});

describe("checkCursor", () => {
  it("starts a minute before the last completed check of the source", () => {
    const settings = { orders_checked_at: "2026-10-07T11:55:00.000Z", stock_checked_at: "2026-10-07T11:00:00.000Z" } as any;
    expect(checkCursor(settings, "sales_orders", T)).toBe("2026-10-07T11:54:00.000Z");
    expect(checkCursor(settings, "inventory", T)).toBe("2026-10-07T10:59:00.000Z");
  });

  it("looks back an hour the first time", () => {
    expect(checkCursor({} as any, "sales_orders", T)).toBe(new Date(T - FIRST_LOOKBACK_MS).toISOString());
  });
});

describe("latestPull", () => {
  it("reads the newest check of the source", async () => {
    const swell = makeSwell({ latest: { id: "p1", source: "inventory" } });
    expect(await latestPull(swell, "inventory")).toEqual({ id: "p1", source: "inventory" });
    expect(swell.get).toHaveBeenCalledWith("/pulls", { where: { source: "inventory" }, sort: "date_created desc", limit: 1 });
  });
});

describe("pullSource: sales orders", () => {
  it("saves only the checkpoint when nothing changed", async () => {
    let query: Record<string, string> = {};
    stub({
      "GET /sales_orders": (url: URL) => {
        query = params(url);
        return { data: [salesOrder({ status: "NOT_SHIPPED" })] };
      },
    });
    const swell = makeSwell();

    const result = await pullSource(ctx(swell, { ...SETTINGS, orders_checked_at: "2026-10-07T11:55:00.000Z" }), "sales_orders", undefined, T + 7000, now);

    expect(query).toMatchObject({ ecommerce_order_type: "swell", updated_at_min: "2026-10-07T11:54:00.000Z", include_deleted: "true", page: "1" });
    expect(result).toMatchObject({ complete: true, changed: 0, not_found: 0, failed: 0 });
    expect(result.run).toBeUndefined();
    expect(swell.post).not.toHaveBeenCalled();
    expect(settingsPut(swell)).toEqual([["/settings/katana", { katana: { orders_checked_at: "2026-10-07T12:00:00.000Z" } }]]);
  });

  it("logs a check that updated orders", async () => {
    stub({ "GET /sales_orders": { data: [salesOrder(), salesOrder({ id: 901, ecommerce_order_id: null })] } });
    const swell = makeSwell();

    const result = await pullSource(ctx(swell), "sales_orders", undefined, T + 7000, now);

    expect(result).toMatchObject({ complete: true, changed: 1, not_found: 1 });
    expect(swell.put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, expect.objectContaining({ $app: { katana: expect.objectContaining({ katana_status: "PACKED" }) } }));
    expect(swell.post).toHaveBeenCalledWith("/pulls", {
      source: "sales_orders",
      date_cursor: new Date(T - FIRST_LOOKBACK_MS).toISOString(),
      date_pass_started: "2026-10-07T12:00:00.000Z",
      changed: 1,
      not_found: 1,
      failed: 0,
      status: "completed",
      page: null,
      date_completed: "2026-10-07T12:00:00.000Z",
    });
  });

  it("pages through full pages", async () => {
    const pages: string[] = [];
    stub({
      "GET /sales_orders": (url: URL) => {
        pages.push(url.searchParams.get("page")!);
        return { data: pages.length === 1 ? Array.from({ length: SALES_ORDER_PAGE }, () => salesOrder({ status: "NOT_SHIPPED" })) : [] };
      },
    });
    const result = await pullSource(ctx(makeSwell()), "sales_orders", undefined, T + 7000, now);
    expect(pages).toEqual(["1", "2"]);
    expect(result.complete).toBe(true);
  });

  it("continues a running check at its cursor and page", async () => {
    let query: Record<string, string> = {};
    stub({
      "GET /sales_orders": (url: URL) => {
        query = params(url);
        return { data: [salesOrder()] };
      },
    });
    const latest = { id: "p1", source: "sales_orders", status: "running", changed: 2, not_found: 0, failed: 0, page: 3, date_cursor: "2026-10-07T10:00:00.000Z", date_pass_started: "2026-10-07T11:50:00.000Z" };
    const swell = makeSwell({ latest });

    const result = await pullSource(ctx(swell), "sales_orders", latest as any, T + 7000, now);

    expect(query).toMatchObject({ updated_at_min: "2026-10-07T10:00:00.000Z", page: "3" });
    expect(swell.put).toHaveBeenCalledWith("/pulls/p1", expect.objectContaining({ changed: 3, status: "completed", page: null }));
    expect(settingsPut(swell)).toEqual([["/settings/katana", { katana: { orders_checked_at: "2026-10-07T11:50:00.000Z" } }]]);
    expect(result.run).toMatchObject({ id: "p1", changed: 3 });
  });

  it("keeps a check running when time runs out", async () => {
    const swell = makeSwell();
    const result = await pullSource(ctx(swell), "sales_orders", undefined, T - 1, now);
    expect(result.complete).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settingsPut(swell)).toEqual([]);
    expect(swell.post).toHaveBeenCalledWith("/pulls", expect.objectContaining({ status: "running", page: 1 }));
  });

  it("keeps a check running after an error and records it", async () => {
    stub({ "GET /sales_orders": () => jsonResponse({ message: "down" }, 503) });
    const swell = makeSwell();
    const result = await pullSource(ctx(swell), "sales_orders", undefined, T + 7000, now);
    expect(result).toMatchObject({ complete: false, last_error: "Sales orders: Katana 503: down" });
    expect(swell.post).toHaveBeenCalledWith(
      "/pulls",
      expect.objectContaining({ status: "running", last_error: "Sales orders: Katana 503: down", date_last_error: "2026-10-07T12:00:00.000Z" }),
    );
  });

  it("counts a sales order that can't be applied and carries on", async () => {
    stub({
      "GET /sales_orders": { data: [salesOrder({ status: "DELIVERED" })] },
      "GET /sales_order_fulfillments": () => jsonResponse({ message: "Forbidden" }, 403),
    });
    const swell = makeSwell();
    const result = await pullSource(ctx(swell), "sales_orders", undefined, T + 7000, now);
    expect(result).toMatchObject({ complete: true, failed: 1, last_error: "Sales order SW-100506: Katana 403: Forbidden" });
    expect(swell.post).toHaveBeenCalledWith("/pulls", expect.objectContaining({ status: "completed", failed: 1 }));
  });
});

describe("pullSource: inventory", () => {
  it("sets stock of the variants that moved", async () => {
    let movementQuery: Record<string, string> = {};
    stub({
      "GET /inventory_movements": (url: URL) => {
        movementQuery = params(url);
        return { data: [{ id: 1, variant_id: 11, location_id: 7 }, { id: 2, variant_id: 11, location_id: 7 }] };
      },
      "GET /inventory": { data: [{ variant_id: 11, location_id: 7, quantity_in_stock: "9", quantity_committed: "0", variant: { id: 11, sku: "SIMPLE" } }] },
    });
    const swell = makeSwell();

    const result = await pullSource(ctx(swell), "inventory", undefined, Infinity, now);

    expect(movementQuery).toMatchObject({ location_id: "7", created_at_min: new Date(T - FIRST_LOOKBACK_MS).toISOString(), limit: String(MOVEMENT_PAGE) });
    expect(result).toMatchObject({ complete: true, changed: 1 });
    expect(swell.post).toHaveBeenCalledWith("/products:stock", expect.objectContaining({ parent_id: "p_simple", quantity: 5 }));
    expect(swell.post).toHaveBeenCalledWith(
      "/pulls",
      expect.objectContaining({
        source: "inventory",
        changed: 1,
        status: "completed",
        report_rows: 1,
        report: [{ product: "SIMPLE", variant: null, change: 5, sku: "SIMPLE" }],
      }),
    );
    expect(settingsPut(swell)).toEqual([["/settings/katana", { katana: { stock_checked_at: "2026-10-07T12:00:00.000Z" } }]]);
  });

  it("appends stock changes to a running check's report", async () => {
    stub({
      "GET /inventory_movements": { data: [{ id: 1, variant_id: 11, location_id: 7 }] },
      "GET /inventory": { data: [{ variant_id: 11, location_id: 7, quantity_in_stock: "6", variant: { id: 11, sku: "SIMPLE" } }] },
    });
    const latest = { id: "p1", source: "inventory", status: "running", changed: 3, report_rows: 3, page: 2, date_cursor: "2026-10-07T11:00:00.000Z", date_pass_started: "2026-10-07T11:55:00.000Z" };
    const swell = makeSwell({ latest });

    await pullSource(ctx(swell), "inventory", latest as any, Infinity, now);

    expect(swell.put).toHaveBeenCalledWith(
      "/pulls/p1",
      expect.objectContaining({
        changed: 4,
        report_rows: 4,
        $push: { report: { $each: [{ product: "SIMPLE", variant: null, change: 2, sku: "SIMPLE" }] } },
      }),
    );
  });

  it("keeps sales order checks without a report", async () => {
    stub({ "GET /sales_orders": { data: [salesOrder()] } });
    const swell = makeSwell();
    await pullSource(ctx(swell), "sales_orders", undefined, T + 7000, now);
    const body = swell.post.mock.calls.find(([url]: [string]) => url === "/pulls")[1];
    expect(body).not.toHaveProperty("report");
    expect(body).not.toHaveProperty("report_rows");
  });

  it("doesn't log moves of SKUs that aren't in Swell", async () => {
    stub({
      "GET /inventory_movements": { data: [{ id: 1, variant_id: 12, location_id: 7 }] },
      "GET /inventory": { data: [{ variant_id: 12, location_id: 7, quantity_in_stock: "3", variant: { id: 12, sku: "RAW-MATERIAL" } }] },
    });
    const swell = makeSwell();
    const result = await pullSource(ctx(swell), "inventory", undefined, Infinity, now);
    expect(result).toMatchObject({ complete: true, changed: 0, not_found: 1 });
    expect(swell.post).not.toHaveBeenCalledWith("/pulls", expect.anything());
  });

  it("skips the inventory read when nothing moved", async () => {
    stub({ "GET /inventory_movements": { data: [] } });
    await pullSource(ctx(makeSwell()), "inventory", undefined, Infinity, now);
    expect(katanaCalls(fetchMock)).toEqual(["GET /inventory_movements"]);
  });
});

describe("runChecks", () => {
  it("checks both sources, alternating which goes first", async () => {
    stub({ "GET /sales_orders": { data: [] }, "GET /inventory_movements": { data: [] } });
    const first = await runChecks(ctx(makeSwell()), 7000, () => T);
    const second = await runChecks(ctx(makeSwell()), 7000, () => T + 5 * 60_000);
    expect(first.map((r) => r.source)).toEqual(["sales_orders", "inventory"]);
    expect(second.map((r) => r.source)).toEqual(["inventory", "sales_orders"]);
  });

  it("stops starting sources when the budget is used up", async () => {
    expect(await runChecks(ctx(makeSwell()), -1, () => T)).toEqual([]);
  });
});

describe("describeChecks", () => {
  const base = { cursor: "2026-10-07T11:54:00.000Z", complete: true, changed: 0, not_found: 0, failed: 0 };

  it("summarizes each source", () => {
    const results: PullResult[] = [
      { ...base, source: "sales_orders", changed: 2, not_found: 1 },
      { ...base, source: "inventory", changed: 3, not_found: 4 },
    ];
    expect(describeChecks(SETTINGS as any, results)).toBe(
      "Sales orders changed since 2026-10-07T11:54:00.000Z: 2 Swell orders updated, 1 sales orders without a Swell order. " +
        "Stock changed since 2026-10-07T11:54:00.000Z: 3 Swell stock levels changed, 4 moved SKUs not in Swell.",
    );
  });

  it("explains failures, unfinished and skipped sources", () => {
    const results: PullResult[] = [{ ...base, source: "sales_orders", complete: false, failed: 1, last_error: "Sales order SW-1: bad" }];
    expect(describeChecks(SETTINGS as any, results)).toBe(
      "Sales orders changed since 2026-10-07T11:54:00.000Z: 0 Swell orders updated, 0 sales orders without a Swell order, 1 failed (Sales order SW-1: bad). Not finished; the next check continues. " +
        "Stock: not checked this time, the next check runs it.",
    );
    const errored: PullResult[] = [{ ...base, source: "sales_orders", complete: false, last_error: "Sales orders: Katana 503: down" }];
    expect(describeChecks({ ...SETTINGS, sync_inventory: false } as any, errored)).toBe(
      "Sales orders changed since 2026-10-07T11:54:00.000Z: 0 Swell orders updated, 0 sales orders without a Swell order. Not finished (Sales orders: Katana 503: down); the next check continues.",
    );
  });
});
