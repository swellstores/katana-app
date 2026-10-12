import { describe, it, expect } from "vitest";
import {
  DuplicateSkuError,
  MissingSkuError,
  SkuError,
  buildCustomer,
  buildSalesOrder,
  buildShippingFee,
  findMissingSkus,
  formatAddress,
  itemSku,
  orderNo,
  katanaItems,
  stockTarget,
} from "../../functions/lib/mapping";
import { SETTINGS, makeOrder } from "../helpers/fixtures";

const settings = SETTINGS as any;
const variants = new Map([["ETH-YIRG-1K-ESP", { id: 501, sku: "ETH-YIRG-1K-ESP" }]]);

describe("katanaItems", () => {
  it("keeps items delivered by shipment", () => {
    const order = { items: [{ id: 1, delivery: "shipment" }, { id: 2, delivery: null }, { id: 3, delivery: "subscription" }] };
    expect(katanaItems(order).map((i) => i.id)).toEqual([1]);
    expect(katanaItems({})).toEqual([]);
  });

  it("keeps digital items whose product tracks stock", () => {
    const order = {
      items: [
        { id: 1, delivery: null, product: { stock_tracking: true } },
        { id: 2, product: { stock_tracking: true } },
        { id: 3, delivery: null, product: { stock_tracking: false } },
        { id: 4, delivery: null },
      ],
    };
    expect(katanaItems(order).map((i) => i.id)).toEqual([1, 2]);
  });

  it("skips gift cards and subscriptions even when they track stock", () => {
    const order = {
      items: [
        { id: 1, delivery: "giftcard", product: { stock_tracking: true } },
        { id: 2, delivery: "subscription", product: { stock_tracking: true } },
      ],
    };
    expect(katanaItems(order)).toEqual([]);
  });
});

describe("SKU errors", () => {
  it("names the missing and duplicate SKUs", () => {
    const missing = new MissingSkuError(["A", "B"]);
    const duplicate = new DuplicateSkuError(["C"]);
    expect(missing.message).toBe("Not found in Katana (by SKU): A, B");
    expect(duplicate.message).toBe("Same SKU on more than one Swell product or variant: C");
    expect(duplicate.skus).toEqual(["C"]);
    expect(missing).toBeInstanceOf(SkuError);
    expect(duplicate).toBeInstanceOf(SkuError);
    expect(duplicate.name).toBe("DuplicateSkuError");
  });
});

describe("itemSku", () => {
  it("prefers the variant SKU, then the item, then the product", () => {
    expect(itemSku({ variant: { sku: " V " }, sku: "I", product: { sku: "P" } })).toBe("V");
    expect(itemSku({ sku: "I", product: { sku: "P" } })).toBe("I");
    expect(itemSku({ product: { sku: "P" } })).toBe("P");
    expect(itemSku({ product: { sku: "" } })).toBeUndefined();
  });
});

describe("orderNo", () => {
  it("prefixes the Swell order number", () => {
    expect(orderNo({ number: "1001" }, settings)).toBe("SW-1001");
    expect(orderNo({ number: "1001" }, { order_no_prefix: "" })).toBe("1001");
    expect(orderNo({ number: "1001" }, {})).toBe("SW-1001");
  });
});

describe("formatAddress", () => {
  it("maps a Swell address to a Katana address", () => {
    expect(formatAddress(makeOrder().shipping, "shipping")).toEqual({
      entity_type: "shipping",
      first_name: "Ada",
      last_name: "Lovelace",
      company: null,
      phone: null,
      line_1: "417 Montgomery St",
      line_2: null,
      city: "San Francisco",
      state: "CA",
      zip: "94104",
      country: "US",
    });
  });

  it("splits the name when first/last names are missing", () => {
    expect(formatAddress({ name: "Grace Brewster Hopper", city: "NYC" }, "billing")).toMatchObject({
      first_name: "Grace",
      last_name: "Brewster Hopper",
    });
  });

  it("returns undefined for an empty address", () => {
    expect(formatAddress({}, "billing")).toBeUndefined();
    expect(formatAddress(undefined, "billing")).toBeUndefined();
  });
});

describe("buildCustomer", () => {
  it("builds a customer from the account and addresses", () => {
    const customer = buildCustomer(makeOrder());
    expect(customer).toMatchObject({
      name: "Ada Lovelace",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      currency: "USD",
      reference_id: "6ac623e9bf440b0012d666be",
    });
    expect((customer.addresses as any[]).map((a) => a.entity_type)).toEqual(["billing", "shipping"]);
  });

  it("falls back to the address name, then email, then the order number", () => {
    expect(buildCustomer(makeOrder({ account: {} })).name).toBe("Ada Lovelace");
    expect(buildCustomer({ number: "9", account: { email: "x@y.z" } }).name).toBe("x@y.z");
    expect(buildCustomer({ number: "9" }).name).toBe("Swell order 9");
  });
});

describe("findMissingSkus", () => {
  it("lists SKUs that are not in Katana and items without a SKU", () => {
    const items = [
      { variant: { sku: "ETH-YIRG-1K-ESP" } },
      { variant: { sku: "MISSING" } },
      { product: { name: "Mug" } },
    ];
    expect(findMissingSkus(items, variants)).toEqual(["MISSING", "Mug (no SKU)"]);
  });
});

describe("buildSalesOrder", () => {
  it("builds the Katana sales order", () => {
    const body = buildSalesOrder(makeOrder(), { settings, customerId: 12, variantsBySku: variants, storeId: "onixo" });
    expect(body).toMatchObject({
      order_no: "SW-100506",
      customer_id: 12,
      location_id: 7,
      currency: "USD",
      order_created_date: "2026-10-07T10:50:19.951Z",
      customer_ref: "100506",
      additional_info: "Leave at the door",
      ecommerce_order_type: "swell",
      ecommerce_store_name: "onixo",
      ecommerce_order_id: "6ac623e9bf440b0012d666b9",
    });
    expect(body.sales_order_rows).toEqual([
      { variant_id: 501, quantity: 2, price_per_unit: 60, total_discount: 10, tax_rate_id: 3, location_id: 7 },
    ]);
    expect((body.addresses as any[]).length).toBe(2);
  });

  it("adds digital items that track stock next to physical ones", () => {
    const order = makeOrder();
    order.items.push(
      { id: "item_d", delivery: null, quantity: 1, price: 25, product: { name: "Course", sku: "COURSE-1", stock_tracking: true } } as any,
      { id: "item_g", delivery: "giftcard", quantity: 1, price: 50, product: { name: "Gift card", stock_tracking: true } } as any,
    );
    const both = new Map([...variants, ["COURSE-1", { id: 777, sku: "COURSE-1" }]]);
    const body = buildSalesOrder(order, { settings, customerId: 12, variantsBySku: both, storeId: "onixo" });
    expect((body.sales_order_rows as any[]).map((row) => row.variant_id)).toEqual([501, 777]);
  });

  it("requires a Katana SKU for digital items that track stock", () => {
    const order = makeOrder({
      items: [{ id: "item_d", delivery: null, quantity: 1, price: 25, product: { name: "Course", stock_tracking: true } }],
    });
    expect(() => buildSalesOrder(order, { settings, customerId: 12, variantsBySku: variants, storeId: "onixo" })).toThrow(
      "Not found in Katana (by SKU): Course (no SKU)",
    );
  });

  it("leaves out optional fields that aren't set", () => {
    const order = makeOrder({ comments: undefined, currency: undefined });
    order.items[0].discount_total = 0;
    const body = buildSalesOrder(order, {
      settings: { ...settings, tax_rate_id: undefined },
      customerId: 12,
      variantsBySku: variants,
      storeId: "onixo",
    });
    expect(body).not.toHaveProperty("additional_info");
    expect(body).not.toHaveProperty("currency");
    expect((body.sales_order_rows as any[])[0]).toEqual({ variant_id: 501, quantity: 2, price_per_unit: 60, location_id: 7 });
  });

  it("throws MissingSkuError when a SKU is not in Katana", () => {
    expect(() =>
      buildSalesOrder(makeOrder(), { settings, customerId: 1, variantsBySku: new Map(), storeId: "s" }),
    ).toThrow(MissingSkuError);
  });
});

describe("buildShippingFee", () => {
  it("builds the fee from the shipment price", () => {
    expect(buildShippingFee(makeOrder(), 77, settings)).toEqual({
      sales_order_id: 77,
      amount: "5.00",
      description: "Ground",
      tax_rate_id: 3,
    });
  });

  it("returns null for free shipping", () => {
    expect(buildShippingFee(makeOrder({ shipment_price: 0, shipment_total: 0 }), 77, settings)).toBeNull();
  });
});

describe("stockTarget", () => {
  const row = { variant_id: 1, location_id: 7, quantity_in_stock: "10.50000", quantity_committed: "3.00000" };

  it("uses in stock minus committed by default", () => {
    expect(stockTarget(row, "available")).toBe(7);
    expect(stockTarget(row, undefined)).toBe(7);
  });

  it("can use the in-stock quantity", () => {
    expect(stockTarget(row, "in_stock")).toBe(10);
  });

  it("keeps negative stock", () => {
    expect(stockTarget({ ...row, quantity_in_stock: "1", quantity_committed: "5" }, "available")).toBe(-4);
    expect(stockTarget({ ...row, quantity_in_stock: "-3", quantity_committed: "0" }, "in_stock")).toBe(-3);
    expect(stockTarget({ ...row, quantity_in_stock: "-2.5", quantity_committed: "0" }, "in_stock")).toBe(-3);
  });

  it("treats missing quantities as zero", () => {
    expect(stockTarget({ variant_id: 1, location_id: 7 }, "available")).toBe(0);
  });
});
