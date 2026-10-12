import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ProductExportError,
  buildKatanaProduct,
  exportProduct,
  isVariable,
  productItems,
  startingStockRows,
} from "../../functions/lib/products";
import { SETTINGS, katanaCalls, katanaFetch, params } from "../helpers/fixtures";

const settings = SETTINGS as any;

const simple = { id: "p_simple", name: "Mug", sku: "MUG", price: 12, cost: 4, stock_level: 7, stock_tracking: true };
const colored = {
  id: "p_color",
  name: "Simple",
  sku: "SMPL",
  price: 4,
  stock_level: 14,
  options: [
    { id: "o1", name: "Color", variant: true, values: [{ id: "red", name: "red" }, { id: "green", name: "green" }] },
    { id: "o2", name: "Gift note", variant: false, values: [] },
  ],
};
const variants = [
  { id: "v1", parent_id: "p_color", name: "red", sku: "SMPR", stock_level: 14, option_value_ids: ["red"] },
  { id: "v2", parent_id: "p_color", name: "green", sku: "SMPG", price: 5, stock_level: 1, option_value_ids: ["green"] },
  { id: "v3", parent_id: "p_color", name: "blue", stock_level: 3, option_value_ids: [] },
];

let fetchMock: ReturnType<typeof katanaFetch>;
const stub = (routes: Record<string, unknown>) => {
  fetchMock = katanaFetch(routes);
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
};
const bodies = (key: string) =>
  fetchMock.mock.calls
    .filter(([input, init]: any[]) => `${(init?.method || "GET").toUpperCase()} ${new URL(String(input)).pathname.replace(/^\/v1/, "")}` === key)
    .map(([, init]: any[]) => JSON.parse(String(init.body)));

beforeEach(() => stub({}));
afterEach(() => vi.restoreAllMocks());

describe("isVariable", () => {
  it("is true when an option creates variants", () => {
    expect(isVariable(colored)).toBe(true);
    expect(isVariable(simple)).toBe(false);
    expect(isVariable({ options: [{ variant: false }] })).toBe(false);
  });
});

describe("productItems", () => {
  it("uses the product itself when it has no variants", () => {
    expect(productItems(simple)).toEqual({
      items: [{ sku: "MUG", name: "Mug", stock_level: 7, price: 12, cost: 4, config_attributes: [] }],
      skipped: 0,
    });
  });

  it("skips a simple product without a SKU", () => {
    expect(productItems({ ...simple, sku: "" })).toEqual({ items: [], skipped: 1 });
  });

  it("uses variants with their option values and the product's price as fallback", () => {
    const { items, skipped } = productItems(colored, variants);
    expect(skipped).toBe(1);
    expect(items).toEqual([
      { sku: "SMPR", name: "red", stock_level: 14, price: 4, cost: null, config_attributes: [{ config_name: "Color", config_value: "red" }] },
      { sku: "SMPG", name: "green", stock_level: 1, price: 5, cost: null, config_attributes: [{ config_name: "Color", config_value: "green" }] },
    ]);
  });

  it("rounds stock down and never below 0", () => {
    expect(productItems({ ...simple, stock_level: 2.7 }).items[0].stock_level).toBe(2);
    expect(productItems({ ...simple, stock_level: -3 }).items[0].stock_level).toBe(0);
  });
});

describe("buildKatanaProduct", () => {
  it("builds a sellable product with configs from the variant options", () => {
    const { items } = productItems(colored, variants);
    expect(buildKatanaProduct(colored, items)).toEqual({
      name: "Simple",
      uom: "pcs",
      is_sellable: true,
      configs: [{ name: "Color", values: ["red", "green"] }],
      variants: [
        { sku: "SMPR", sales_price: 4, config_attributes: [{ config_name: "Color", config_value: "red" }] },
        { sku: "SMPG", sales_price: 5, config_attributes: [{ config_name: "Color", config_value: "green" }] },
      ],
    });
  });

  it("builds a single-variant product without configs", () => {
    expect(buildKatanaProduct(simple, productItems(simple).items)).toEqual({
      name: "Mug",
      uom: "pcs",
      is_sellable: true,
      variants: [{ sku: "MUG", sales_price: 12, purchase_price: 4 }],
    });
  });
});

describe("startingStockRows", () => {
  const items = productItems(colored, variants).items;
  const katana = new Map([
    ["SMPR", { id: 10, sku: "SMPR" }],
    ["SMPG", { id: 11, sku: "SMPG" }],
  ]);

  it("sets stock only where Katana has none, adding committed quantities", () => {
    const inventory = [
      { variant_id: 10, location_id: 7, quantity_in_stock: "0", quantity_committed: "2" },
      { variant_id: 11, location_id: 7, quantity_in_stock: "5", quantity_committed: "0" },
    ];
    expect(startingStockRows(items, katana, inventory, settings)).toEqual([{ variant_id: 10, quantity: 16 }]);
  });

  it("ignores committed quantities when Swell stock follows Katana's in-stock", () => {
    const inventory = [{ variant_id: 10, location_id: 7, quantity_in_stock: "0", quantity_committed: "2" }];
    expect(startingStockRows(items, katana, inventory, { ...settings, stock_quantity: "in_stock" })).toEqual([
      { variant_id: 10, quantity: 14 },
      { variant_id: 11, quantity: 1 },
    ]);
  });

  it("skips items without Swell stock or a Katana variant, and sends the cost", () => {
    const mug = productItems({ ...simple, stock_level: 0 }).items;
    expect(startingStockRows(mug, new Map([["MUG", { id: 1 }]]), [], settings)).toEqual([]);
    expect(startingStockRows(productItems(simple).items, new Map(), [], settings)).toEqual([]);
    expect(startingStockRows(productItems(simple).items, new Map([["MUG", { id: 1 }]]), [], settings)).toEqual([
      { variant_id: 1, quantity: 7, cost_per_unit: 4 },
    ]);
  });
});

describe("exportProduct", () => {
  const { items } = productItems(colored, variants);

  it("creates the product, reads the new variants back and sets the starting stock", async () => {
    stub({
      "POST /products": { id: 300 },
      "GET /variants": { data: [{ id: 10, sku: "SMPR", product_id: 300 }, { id: 11, sku: "SMPG", product_id: 300 }] },
      "GET /inventory": { data: [] },
      "POST /stock_adjustments": { id: 1 },
    });

    expect(await exportProduct(settings, colored, items, new Map())).toEqual({ created: true, variants_created: 2, adjusted: 2 });

    expect(katanaCalls(fetchMock)).toEqual(["POST /products", "GET /variants", "GET /inventory", "POST /stock_adjustments"]);
    expect(bodies("POST /stock_adjustments")[0]).toEqual({
      location_id: 7,
      stock_adjustment_rows: [{ variant_id: 10, quantity: 14 }, { variant_id: 11, quantity: 1 }],
      stock_adjustment_date: expect.any(String),
      reason: "Starting stock from Swell",
      additional_info: "Swell product Simple (p_color)",
    });
  });

  it("adds missing variants to the existing Katana product", async () => {
    stub({
      "POST /variants": (_url: URL, body: any) => ({ id: 11, ...body }),
      "GET /variants": { data: [{ id: 11, sku: "SMPG", product_id: 300 }] },
      "GET /inventory": { data: [{ variant_id: 10, quantity_in_stock: "14" }, { variant_id: 11, quantity_in_stock: "0" }] },
      "POST /stock_adjustments": { id: 1 },
    });
    const known = new Map([["SMPR", { id: 10, sku: "SMPR", product_id: 300 }]]);

    expect(await exportProduct(settings, colored, items, known)).toEqual({ created: true, variants_created: 1, adjusted: 1 });
    expect(bodies("POST /variants")).toEqual([
      { product_id: 300, sku: "SMPG", sales_price: 5, config_attributes: [{ config_name: "Color", config_value: "green" }] },
    ]);
  });

  it("only sets stock when every SKU is already in Katana", async () => {
    let inventoryQuery: Record<string, string> = {};
    stub({
      "GET /inventory": (url: URL) => {
        inventoryQuery = params(url);
        return { data: [{ variant_id: 10, quantity_in_stock: "3" }, { variant_id: 11, quantity_in_stock: "1" }] };
      },
    });
    const known = new Map([
      ["SMPR", { id: 10, sku: "SMPR", product_id: 300 }],
      ["SMPG", { id: 11, sku: "SMPG", product_id: 300 }],
    ]);

    expect(await exportProduct(settings, colored, items, known)).toEqual({ created: false, variants_created: 0, adjusted: 0 });
    expect(katanaCalls(fetchMock)).toEqual(["GET /inventory"]);
    expect(inventoryQuery).toMatchObject({ location_id: "7" });
  });

  it("refuses to add variants to a Katana material", async () => {
    const known = new Map([["SMPR", { id: 10, sku: "SMPR", product_id: null }]]);
    await expect(exportProduct(settings, colored, items, known)).rejects.toThrow(
      new ProductExportError("SKU SMPR is a Katana material, not a product"),
    );
  });

  it("reports SKUs Katana didn't return", async () => {
    stub({ "POST /products": { id: 300 }, "GET /variants": { data: [] } });
    await expect(exportProduct(settings, colored, items, new Map())).rejects.toThrow("Katana didn't return the new SKUs: SMPR, SMPG");
  });
});
