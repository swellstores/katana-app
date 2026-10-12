import { vi } from "vitest";

export const SETTINGS = {
  api_key: "katana-key",
  location_id: 7,
  tax_rate_id: 3,
  sync_on: "paid",
  order_no_prefix: "SW-",
  on_cancel: "delete",
  create_fulfillment: true,
  sync_inventory: true,
  stock_quantity: "available",
  enabled: true,
};

export const ORDER_ID = "6ac623e9bf440b0012d666b9";
export const ACCOUNT_ID = "6ac623e9bf440b0012d666be";

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: ORDER_ID,
    number: "100506",
    status: "delivery_pending",
    paid: true,
    currency: "USD",
    grand_total: 125,
    sub_total: 120,
    shipment_price: 5,
    shipment_total: 5,
    date_created: "2026-10-07T10:50:19.951Z",
    comments: "Leave at the door",
    account_id: ACCOUNT_ID,
    account: { id: ACCOUNT_ID, email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", name: "Ada Lovelace" },
    shipping: {
      name: "Ada Lovelace",
      first_name: "Ada",
      last_name: "Lovelace",
      address1: "417 Montgomery St",
      city: "San Francisco",
      state: "CA",
      zip: "94104",
      country: "us",
      service_name: "Ground",
    },
    billing: {
      name: "Ada Lovelace",
      first_name: "Ada",
      last_name: "Lovelace",
      address1: "417 Montgomery St",
      city: "San Francisco",
      state: "CA",
      zip: "94104",
      country: "us",
    },
    items: [
      {
        id: "item_1",
        delivery: "shipment",
        quantity: 2,
        quantity_shipment_deliverable: 2,
        price: 60,
        price_total: 120,
        discount_total: 10,
        product_id: "prod_1",
        variant_id: "var_1",
        product: { name: "Ethiopia Yirgacheffe", sku: "ETH-YIRG" },
        variant: { sku: "ETH-YIRG-1K-ESP" },
      },
    ],
    ...overrides,
  };
}

// swell.get mock that answers by path
export function routeGet(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, query?: unknown) => {
    for (const [prefix, value] of Object.entries(routes)) {
      if (url === prefix || url.startsWith(`${prefix}?`)) {
        return typeof value === "function" ? (value as (q: unknown) => unknown)(query) : value;
      }
    }
    return null;
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type KatanaHandler = unknown | ((url: URL, body: any) => unknown);

// fetch mock for the Katana API: keys are "METHOD /path" (path without query string)
export function katanaFetch(routes: Record<string, KatanaHandler>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method || "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "");
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return jsonResponse({ statusCode: 404, message: `No mock for ${key}` }, 404);
    }
    const handler = routes[key];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const result = typeof handler === "function" ? (handler as (u: URL, b: any) => unknown)(url, body) : handler;
    if (result instanceof Response) {
      return result;
    }
    return result === undefined ? new Response(null, { status: 204 }) : jsonResponse(result);
  });
}

// calls made to the Katana fetch mock, as "METHOD /path"
export function katanaCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([input, init]: any[]) => {
    const url = new URL(String(input));
    return `${(init?.method || "GET").toUpperCase()} ${url.pathname.replace(/^\/v1/, "")}`;
  });
}

export const appValues = (values: Record<string, unknown>) => ({ $app: { katana: values } });

// query string of a URL as a plain object
export function params(url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
