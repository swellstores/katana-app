import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DUPLICATE_LIMIT,
  REPORT_LIMIT,
  applyInventory,
  findStockTargets,
  mergeSkus,
  reportPush,
  saveSyncState,
  setStockLevel,
} from "../../functions/lib/stock";
import { SETTINGS, appValues } from "../helpers/fixtures";

const settings = SETTINGS as any;

// swell mock with a simple product (SIMPLE), a variable product (VAR-PARENT) and its variant (VAR-1);
// `extraVariants` adds more variants of VAR-PARENT, e.g. to reuse a SKU
function makeSwell({ tracking = true, extraVariants = [] as any[] } = {}) {
  const get = vi.fn(async (url: string, query: any) => {
    if (url === "/products" && query?.where?.sku) {
      return {
        results: [
          { id: "p_simple", name: "Mug", sku: "SIMPLE", stock_level: 4, stock_tracking: tracking },
          { id: "p_var", name: "Shirt", sku: "VAR-PARENT", stock_level: 9, stock_tracking: tracking, options: [{ variant: true }] },
        ].filter((p) => query.where.sku.$in.includes(p.sku)),
      };
    }
    if (url === "/products:variants") {
      return {
        results: [{ id: "v_1", parent_id: "p_var", name: "Small", sku: "VAR-1" }, ...extraVariants].filter((v) =>
          query.where.sku.$in.includes(v.sku),
        ),
      };
    }
    if (url === "/products" && query?.where?.id) {
      return { results: [{ id: "p_var", name: "Shirt", stock_tracking: tracking }] };
    }
    return null;
  });
  return { get, post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) } as any;
}

const row = (sku: string | null, inStock: number, committed = 0) => ({
  variant_id: 1,
  location_id: 7,
  quantity_in_stock: String(inStock),
  quantity_committed: String(committed),
  variant: sku ? { id: 1, sku } : undefined,
});

afterEach(() => vi.restoreAllMocks());

describe("findStockTargets", () => {
  it("maps simple products and variants by SKU, skipping variable parents", async () => {
    const swell = makeSwell();
    const { targets, duplicates } = await findStockTargets(swell, ["SIMPLE", "VAR-PARENT", "VAR-1", "SIMPLE"]);
    expect(duplicates.size).toBe(0);
    expect(targets.get("SIMPLE")).toEqual({
      sku: "SIMPLE",
      product_id: "p_simple",
      variant_id: null,
      product_name: "Mug",
      variant_name: null,
      stock_level: 4,
      stock_tracking: true,
    });
    expect(targets.get("VAR-1")).toEqual({
      sku: "VAR-1",
      product_id: "p_var",
      variant_id: "v_1",
      product_name: "Shirt",
      variant_name: "Small",
      stock_level: 0,
      stock_tracking: true,
    });
    expect(targets.has("VAR-PARENT")).toBe(false);
  });

  it("makes no calls for no SKUs", async () => {
    const swell = makeSwell();
    const { targets, duplicates } = await findStockTargets(swell, []);
    expect(targets.size).toBe(0);
    expect(duplicates.size).toBe(0);
    expect(swell.get).not.toHaveBeenCalled();
  });

  it("lists a SKU used by two variants as a duplicate, not a target", async () => {
    const swell = makeSwell({ extraVariants: [{ id: "v_2", parent_id: "p_var", name: "Large", sku: "VAR-1" }] });
    const { targets, duplicates } = await findStockTargets(swell, ["VAR-1", "SIMPLE"]);
    expect([...duplicates]).toEqual(["VAR-1"]);
    expect(targets.has("VAR-1")).toBe(false);
    expect(targets.has("SIMPLE")).toBe(true);
  });

  it("lists a SKU used by a product and a variant as a duplicate", async () => {
    const swell = makeSwell({ extraVariants: [{ id: "v_2", parent_id: "p_var", name: "Large", sku: "SIMPLE" }] });
    const { targets, duplicates } = await findStockTargets(swell, ["SIMPLE"]);
    expect([...duplicates]).toEqual(["SIMPLE"]);
    expect(targets.size).toBe(0);
  });

  it("keeps a SKU used three times as one duplicate", async () => {
    const swell = makeSwell({
      extraVariants: [
        { id: "v_2", parent_id: "p_var", name: "Large", sku: "VAR-1" },
        { id: "v_3", parent_id: "p_var", name: "XL", sku: "VAR-1" },
      ],
    });
    const { targets, duplicates } = await findStockTargets(swell, ["VAR-1"]);
    expect([...duplicates]).toEqual(["VAR-1"]);
    expect(targets.size).toBe(0);
  });
});

describe("mergeSkus", () => {
  it("merges unique SKUs, keeping the existing order", () => {
    expect(mergeSkus(["A", "B"], ["B", "C"])).toEqual(["A", "B", "C"]);
    expect(mergeSkus(undefined, ["A"])).toEqual(["A"]);
  });

  it("keeps at most DUPLICATE_LIMIT SKUs", () => {
    const many = Array.from({ length: DUPLICATE_LIMIT + 5 }, (_, i) => `S${i}`);
    expect(mergeSkus([], many)).toHaveLength(DUPLICATE_LIMIT);
  });
});

describe("setStockLevel", () => {
  const target = {
    sku: "VAR-1",
    product_id: "p_var",
    variant_id: "v_1",
    product_name: "Shirt",
    variant_name: "Small",
    stock_level: 2,
    stock_tracking: true,
  };

  it("posts the difference as a stock adjustment", async () => {
    const swell = makeSwell();
    expect(await setStockLevel(swell, target, 5, 7)).toBe(true);
    expect(swell.post).toHaveBeenCalledWith("/products:stock", {
      parent_id: "p_var",
      variant_id: "v_1",
      quantity: 3,
      reason_message: "Katana stock sync (location 7): 2 → 5",
    });
  });

  it("does nothing when the level already matches", async () => {
    const swell = makeSwell();
    expect(await setStockLevel(swell, target, 2)).toBe(false);
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("omits variant_id for simple products", async () => {
    const swell = makeSwell();
    await setStockLevel(swell, { ...target, variant_id: null }, 0);
    expect(swell.post.mock.calls[0][1]).not.toHaveProperty("variant_id");
    expect(swell.post.mock.calls[0][1].quantity).toBe(-2);
  });
});

describe("applyInventory", () => {
  it("sets stock for matched, tracked SKUs and marks the products", async () => {
    const swell = makeSwell();
    const result = await applyInventory(
      swell,
      [row("SIMPLE", 10, 2), row("VAR-1", 3), row("UNKNOWN", 5), row(null, 1)],
      settings,
      appValues,
    );
    expect(result).toEqual({
      checked: 3,
      updated: 2,
      skipped: 1,
      unmatched: 1,
      duplicates: [],
      complete: true,
      changes: [
        { product: "Mug", variant: null, change: 4, sku: "SIMPLE" },
        { product: "Shirt", variant: "Small", change: 3, sku: "VAR-1" },
      ],
    });
    expect(swell.post).toHaveBeenCalledTimes(2);
    expect(swell.post.mock.calls[0][1]).toMatchObject({ parent_id: "p_simple", quantity: 4 });
    expect(swell.put).toHaveBeenCalledWith("/products/p_simple", {
      $app: { katana: { katana_stock_synced_at: expect.any(String), katana_error: null } },
    });
  });

  it("leaves duplicate SKUs alone and reports them", async () => {
    const swell = makeSwell({ extraVariants: [{ id: "v_2", parent_id: "p_var", name: "Large", sku: "VAR-1" }] });
    const result = await applyInventory(swell, [row("VAR-1", 5), row("VAR-1", 5), row("SIMPLE", 10)], settings, appValues);
    expect(result).toMatchObject({ checked: 3, updated: 1, unmatched: 0, duplicates: ["VAR-1"] });
    expect(swell.post).toHaveBeenCalledTimes(1);
    expect(swell.post.mock.calls[0][1]).toMatchObject({ parent_id: "p_simple" });
  });

  it("writes negative Katana stock to Swell", async () => {
    const swell = makeSwell();
    const result = await applyInventory(swell, [row("SIMPLE", 1, 3)], settings, appValues);
    expect(result.changes).toEqual([{ product: "Mug", variant: null, change: -6, sku: "SIMPLE" }]);
    expect(swell.post.mock.calls[0][1]).toMatchObject({
      parent_id: "p_simple",
      quantity: -6,
      reason_message: expect.stringContaining("4 → -2"),
    });
  });

  it("skips products with stock tracking off", async () => {
    const swell = makeSwell({ tracking: false });
    const result = await applyInventory(swell, [row("SIMPLE", 10)], settings, appValues);
    expect(result).toMatchObject({ checked: 1, updated: 0, skipped: 1 });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("stops when the deadline has passed", async () => {
    const swell = makeSwell();
    const result = await applyInventory(swell, [row("SIMPLE", 10)], settings, appValues, Date.now() - 1);
    expect(result.complete).toBe(false);
    expect(swell.post).not.toHaveBeenCalled();
  });
});

describe("reportPush", () => {
  const change = { product: "Mug", variant: null, change: 1, sku: "MUG" };

  it("appends the changes to the report", () => {
    expect(reportPush([change])).toEqual({ $push: { report: { $each: [change] } } });
  });

  it("keeps the report within the limit", () => {
    expect(reportPush([change, change], REPORT_LIMIT - 1)).toEqual({ $push: { report: { $each: [change] } } });
    expect(reportPush([change], REPORT_LIMIT)).toEqual({});
    expect(reportPush([])).toEqual({});
  });

  it("lists the columns in table order", () => {
    expect(Object.keys(reportPush([change]).$push.report.$each[0])).toEqual(["product", "variant", "change", "sku"]);
  });
});

describe("saveSyncState", () => {
  it("writes into the app's settings group", async () => {
    const swell = makeSwell();
    await saveSyncState(swell, "katana", { stock_checked_at: "t" });
    expect(swell.put).toHaveBeenCalledWith("/settings/katana", { katana: { stock_checked_at: "t" } });
  });
});
