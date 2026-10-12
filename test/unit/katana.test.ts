import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KatanaError,
  addShippingFee,
  buildQuery,
  createCustomer,
  createSalesOrder,
  deleteSalesOrder,
  errorMessage,
  findCustomerByEmail,
  findSalesOrderByEcommerceId,
  findVariantsBySku,
  getAppData,
  getKatanaSettings,
  getSalesOrder,
  hasCredentials,
  isRetryable,
  katanaRequest,
  listFulfillments,
  listChangedSalesOrders,
  listInventory,
  listInventoryForVariants,
  listInventoryMovements,
  listLocations,
  listTaxRates,
} from "../../functions/lib/katana";
import { SETTINGS, jsonResponse, katanaFetch, params } from "../helpers/fixtures";

const settings = SETTINGS as any;

describe("settings helpers", () => {
  it("getKatanaSettings reads the katana settings group", async () => {
    const swell = { settings: vi.fn().mockResolvedValue({ katana: { api_key: "k" } }) } as any;
    expect(await getKatanaSettings(swell)).toEqual({ api_key: "k" });
  });

  it("getKatanaSettings returns {} when nothing is saved", async () => {
    const swell = { settings: vi.fn().mockResolvedValue(null) } as any;
    expect(await getKatanaSettings(swell)).toEqual({});
  });

  it("hasCredentials needs an API key and a location", () => {
    expect(hasCredentials({ api_key: "k", location_id: 1 })).toBe(true);
    expect(hasCredentials({ api_key: " ", location_id: 1 })).toBe(false);
    expect(hasCredentials({ api_key: "k" })).toBe(false);
  });
});

describe("buildQuery", () => {
  it("repeats array keys and drops empty values", () => {
    expect(buildQuery({ sku: ["A", "B"], limit: 250, page: undefined, x: null, y: "" })).toBe(
      "?sku=A&sku=B&limit=250",
    );
  });

  it("returns an empty string without params", () => {
    expect(buildQuery()).toBe("");
  });
});

describe("errorMessage", () => {
  it("reads wrapped errors", () => {
    expect(errorMessage({ error: { statusCode: 401, message: "Unauthorized" } }, "", "")).toBe("Unauthorized");
  });

  it("joins validation details", () => {
    const json = { message: "Invalid", details: [{ path: ".order_no", message: "is taken" }] };
    expect(errorMessage(json, "", "")).toBe("Invalid: .order_no is taken");
  });

  it("falls back to the text and status text", () => {
    expect(errorMessage(null, "Bad gateway", "x")).toBe("Bad gateway");
    expect(errorMessage(null, "", "Server Error")).toBe("Server Error");
  });
});

describe("isRetryable", () => {
  it("retries 429 and 5xx but not other 4xx", () => {
    expect(isRetryable(new KatanaError("x", 429))).toBe(true);
    expect(isRetryable(new KatanaError("x", 502))).toBe(true);
    expect(isRetryable(new KatanaError("x", 422))).toBe(false);
  });

  it("retries unknown errors", () => {
    expect(isRetryable(new Error("network"))).toBe(true);
  });
});

describe("katanaRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the bearer token and JSON body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: 1 }));
    const result = await katanaRequest(settings, "POST", "/things", { query: { a: 1 }, body: { b: 2 } });

    expect(result).toEqual({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.katanamrp.com/v1/things?a=1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer katana-key");
    expect(init.body).toBe('{"b":2}');
  });

  it("returns null for 204", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    expect(await katanaRequest(settings, "DELETE", "/things/1")).toBeNull();
  });

  it("throws KatanaError with status and message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { statusCode: 401, message: "Unauthorized" } }, 401),
    );
    await expect(katanaRequest(settings, "GET", "/things")).rejects.toMatchObject({
      name: "KatanaError",
      status: 401,
      message: "Katana 401: Unauthorized",
    });
  });

  it("waits out a short Retry-After once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    expect(await katanaRequest(settings, "GET", "/things")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a long Retry-After", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ message: "slow down" }, 429, { "retry-after": "30" }));
    await expect(katanaRequest(settings, "GET", "/things")).rejects.toMatchObject({ status: 429 });
  });
});

describe("resources", () => {
  let fetchMock: ReturnType<typeof katanaFetch>;
  const stub = (routes: Record<string, unknown>) => {
    fetchMock = katanaFetch(routes);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
  };
  const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)![0]));
  const lastBody = () => JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body));

  afterEach(() => vi.restoreAllMocks());

  it("findVariantsBySku queries unique SKUs in chunks and maps by SKU", async () => {
    stub({
      "GET /variants": (url: URL) => ({ data: url.searchParams.getAll("sku").map((sku, i) => ({ id: i + 1, sku })) }),
    });
    const skus = Array.from({ length: 60 }, (_, i) => `SKU-${i}`);
    const result = await findVariantsBySku(settings, [...skus, "SKU-0", ""]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(60);
    expect(result.get("SKU-55")?.sku).toBe("SKU-55");
  });

  it("findVariantsBySku makes no request for no SKUs", async () => {
    stub({});
    expect((await findVariantsBySku(settings, [])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("findCustomerByEmail returns the first match or null", async () => {
    stub({ "GET /customers": { data: [{ id: 5 }] } });
    expect(await findCustomerByEmail(settings, "a@b.c")).toEqual({ id: 5 });
    expect(lastUrl().searchParams.get("email")).toBe("a@b.c");

    stub({ "GET /customers": { data: [] } });
    expect(await findCustomerByEmail(settings, "a@b.c")).toBeNull();
  });

  it("createCustomer posts the customer", async () => {
    stub({ "POST /customers": (_u: URL, body: any) => ({ id: 9, ...body }) });
    expect(await createCustomer(settings, { name: "Ada" })).toEqual({ id: 9, name: "Ada" });
  });

  it("findSalesOrderByEcommerceId filters by ecommerce_order_id", async () => {
    stub({ "GET /sales_orders": { data: [{ id: 3 }] } });
    expect(await findSalesOrderByEcommerceId(settings, "abc")).toEqual({ id: 3 });
    expect(lastUrl().searchParams.get("ecommerce_order_id")).toBe("abc");

    stub({ "GET /sales_orders": { data: [] } });
    expect(await findSalesOrderByEcommerceId(settings, "abc")).toBeNull();
  });

  it("createSalesOrder, getSalesOrder and deleteSalesOrder call the sales order endpoints", async () => {
    stub({
      "POST /sales_orders": { id: 1 },
      "GET /sales_orders/1": { id: 1, status: "NOT_SHIPPED" },
      "DELETE /sales_orders/1": undefined,
    });
    expect(await createSalesOrder(settings, { order_no: "x" })).toEqual({ id: 1 });
    expect(await getSalesOrder(settings, 1)).toEqual({ id: 1, status: "NOT_SHIPPED" });
    await expect(deleteSalesOrder(settings, 1)).resolves.toBeUndefined();
  });

  it("addShippingFee posts the fee", async () => {
    stub({ "POST /sales_order_shipping_fee": { id: 1 } });
    await addShippingFee(settings, { sales_order_id: 1, amount: "5.00" });
    expect(lastBody()).toEqual({ sales_order_id: 1, amount: "5.00" });
  });

  it("listFulfillments filters by sales order", async () => {
    stub({ "GET /sales_order_fulfillments": { data: [{ id: 2 }] } });
    expect(await listFulfillments(settings, 1)).toEqual([{ id: 2 }]);
    expect(lastUrl().searchParams.get("sales_order_id")).toBe("1");
  });

  it("listInventory filters by the configured location and extends variants", async () => {
    stub({ "GET /inventory": { data: [{ variant_id: 1 }] } });
    expect(await listInventory(settings, { variantIds: [1, 2], page: 3, limit: 250 })).toEqual([{ variant_id: 1 }]);
    const url = lastUrl();
    expect(url.searchParams.get("location_id")).toBe("7");
    expect(url.searchParams.getAll("variant_id")).toEqual(["1", "2"]);
    expect(url.searchParams.get("extend")).toBe("variant");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("listLocations and listTaxRates return data arrays", async () => {
    stub({ "GET /locations": { data: [{ id: 7 }] }, "GET /tax_rates": {} });
    expect(await listLocations(settings)).toEqual([{ id: 7 }]);
    expect(await listTaxRates(settings)).toEqual([]);
  });
});

describe("polling queries", () => {
  let fetchMock: ReturnType<typeof katanaFetch>;
  const stub = (routes: Record<string, unknown>) => {
    fetchMock = katanaFetch(routes);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
  };
  const urlAt = (i: number) => new URL(String(fetchMock.mock.calls[i][0]));

  afterEach(() => vi.restoreAllMocks());

  it("listChangedSalesOrders asks for this app's sales orders updated since, including deleted", async () => {
    stub({ "GET /sales_orders": { data: [{ id: 1 }] } });
    expect(await listChangedSalesOrders(settings, "2026-10-07T10:00:00.000Z", 2)).toEqual([{ id: 1 }]);
    expect(params(urlAt(0))).toEqual({
      ecommerce_order_type: "swell",
      updated_at_min: "2026-10-07T10:00:00.000Z",
      include_deleted: "true",
      page: "2",
      limit: "100",
    });
  });

  it("listInventoryMovements asks for movements at the location created since", async () => {
    stub({ "GET /inventory_movements": {} });
    expect(await listInventoryMovements(settings, "2026-10-07T10:00:00.000Z")).toEqual([]);
    expect(params(urlAt(0))).toEqual({
      location_id: "7",
      created_at_min: "2026-10-07T10:00:00.000Z",
      page: "1",
      limit: "250",
    });
  });

  it("listInventoryForVariants reads unique variants in chunks of 50", async () => {
    stub({ "GET /inventory": (url: URL) => ({ data: url.searchParams.getAll("variant_id").map((id) => ({ variant_id: Number(id) })) }) });
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const rows = await listInventoryForVariants(settings, [...ids, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(60);
    expect(urlAt(1).searchParams.getAll("variant_id")).toHaveLength(10);
  });
});

describe("getAppData", () => {
  it("getAppData reads the app namespace", () => {
    expect(getAppData({ $app: { katana: { a: 1 } } }, "katana")).toEqual({ a: 1 });
    expect(getAppData({ $app: { other: { a: 1 } } }, "other")).toEqual({ a: 1 });
    expect(getAppData(null, "katana")).toEqual({});
  });
});
