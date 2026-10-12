import { KatanaInventory, KatanaSettings } from './katana';
import { stockTarget } from './mapping';

// a Swell product or variant that a Katana SKU maps to
export interface StockTarget {
  sku: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  stock_level: number;
  stock_tracking: boolean;
}

export interface StockSyncResult {
  checked: number;
  updated: number;
  skipped: number;
  unmatched: number;
  // SKUs used by more than one Swell product or variant; their stock isn't changed
  duplicates: string[];
}

// Swell products and variants by SKU, and the SKUs that more than one of them uses
export interface StockTargets {
  targets: Map<string, StockTarget>;
  duplicates: Set<string>;
}

// SKUs kept on a sync or check record
export const DUPLICATE_LIMIT = 100;

// merges SKU lists, unique and capped at DUPLICATE_LIMIT
export function mergeSkus(existing: unknown, added: string[]): string[] {
  const before = Array.isArray(existing) ? existing.map(String) : [];
  return [...new Set([...before, ...added])].slice(0, DUPLICATE_LIMIT);
}

// one Swell stock level changed by a sync, for the report on its job or check
export interface StockChange {
  product: string;
  variant: string | null;
  change: number;
  sku: string;
}

// Rows kept in one report; later changes are still applied and counted
export const REPORT_LIMIT = 2000;

// The `$push` that appends changes to a record's `report`, keeping at most REPORT_LIMIT rows
export function reportPush(changes: StockChange[], rowsSoFar: unknown = 0): Record<string, any> {
  const room = Math.max(0, REPORT_LIMIT - (Number(rowsSoFar) || 0));
  return changes.length && room ? { $push: { report: { $each: changes.slice(0, room) } } } : {};
}

function isVariable(product: any): boolean {
  return (product?.options || []).some((option: any) => option?.variant);
}

// Swell products and variants for the given SKUs, keyed by SKU. A SKU used by more than one product
// without variants or variant is a duplicate: it's left out of `targets` and listed in `duplicates`.
export async function findStockTargets(swell: SwellAPI, skus: string[]): Promise<StockTargets> {
  const unique = [...new Set(skus.filter(Boolean))];
  const targets = new Map<string, StockTarget>();
  const duplicates = new Set<string>();
  if (!unique.length) {
    return { targets, duplicates };
  }

  const add = (target: StockTarget) => {
    if (duplicates.has(target.sku)) {
      return;
    }
    if (targets.has(target.sku)) {
      targets.delete(target.sku);
      duplicates.add(target.sku);
      return;
    }
    targets.set(target.sku, target);
  };

  const products = await swell.get('/products', {
    where: { sku: { $in: unique } },
    fields: 'id,name,sku,stock_level,stock_tracking,options.variant',
    limit: 1000,
  });
  for (const product of products?.results || []) {
    // stock of a product with variants lives on the variants
    if (product.sku && !isVariable(product)) {
      add({
        sku: product.sku,
        product_id: product.id,
        variant_id: null,
        product_name: product.name || product.sku,
        variant_name: null,
        stock_level: Number(product.stock_level) || 0,
        stock_tracking: Boolean(product.stock_tracking),
      });
    }
  }

  const variants = await swell.get('/products:variants', {
    where: { sku: { $in: unique } },
    fields: 'id,parent_id,name,sku,stock_level',
    limit: 1000,
  });
  const variantResults = variants?.results || [];
  if (variantResults.length) {
    const parentIds = [...new Set(variantResults.map((v: any) => v.parent_id))];
    const parents = await swell.get('/products', {
      where: { id: { $in: parentIds } },
      fields: 'id,name,stock_tracking',
      limit: 1000,
    });
    const parentById = new Map<string, any>((parents?.results || []).map((p: any) => [p.id, p]));
    for (const variant of variantResults) {
      if (variant.sku) {
        add({
          sku: variant.sku,
          product_id: variant.parent_id,
          variant_id: variant.id,
          product_name: parentById.get(variant.parent_id)?.name || variant.sku,
          variant_name: variant.name || null,
          stock_level: Number(variant.stock_level) || 0,
          stock_tracking: Boolean(parentById.get(variant.parent_id)?.stock_tracking),
        });
      }
    }
  }

  return { targets, duplicates };
}

// posts a stock adjustment so the Swell level equals `level`; returns true when stock changed
export async function setStockLevel(
  swell: SwellAPI,
  target: StockTarget,
  level: number,
  locationId?: number,
): Promise<boolean> {
  const delta = level - target.stock_level;
  if (delta === 0) {
    return false;
  }

  await swell.post('/products:stock', {
    parent_id: target.product_id,
    ...(target.variant_id && { variant_id: target.variant_id }),
    quantity: delta,
    reason_message: `Katana stock sync${locationId ? ` (location ${locationId})` : ''}: ${target.stock_level} → ${level}`,
  });
  return true;
}

// applies Katana inventory rows (with `variant` extended) to Swell stock
export async function applyInventory(
  swell: SwellAPI,
  rows: KatanaInventory[],
  settings: KatanaSettings,
  appValues: (values: SwellData) => SwellData,
  deadline = Infinity,
): Promise<StockSyncResult & { complete: boolean; changes: StockChange[] }> {
  const result = {
    checked: 0,
    updated: 0,
    skipped: 0,
    unmatched: 0,
    duplicates: [] as string[],
    complete: true,
    changes: [] as StockChange[],
  };

  const withSku = rows.filter((row) => row.variant?.sku);
  result.skipped += rows.length - withSku.length;

  const { targets, duplicates } = await findStockTargets(
    swell,
    withSku.map((row) => row.variant!.sku as string),
  );

  const touchedProducts = new Set<string>();
  for (const row of withSku) {
    if (Date.now() > deadline) {
      result.complete = false;
      break;
    }
    result.checked++;

    const sku = row.variant!.sku as string;
    if (duplicates.has(sku)) {
      if (!result.duplicates.includes(sku)) {
        result.duplicates.push(sku);
      }
      continue;
    }
    const target = targets.get(sku);
    if (!target) {
      result.unmatched++;
      continue;
    }
    if (!target.stock_tracking) {
      result.skipped++;
      continue;
    }

    const level = stockTarget(row, settings.stock_quantity);
    const changed = await setStockLevel(swell, target, level, settings.location_id);
    if (changed) {
      result.updated++;
      result.changes.push({
        product: target.product_name,
        variant: target.variant_name,
        change: level - target.stock_level,
        sku: target.sku,
      });
      touchedProducts.add(target.product_id);
    }
  }

  const now = new Date().toISOString();
  for (const productId of touchedProducts) {
    await swell.put(`/products/${productId}`, appValues({ katana_stock_synced_at: now, katana_error: null }));
  }

  return result;
}

// writes app-managed values into this app's settings record
export async function saveSyncState(swell: SwellAPI, appId: string, values: Partial<KatanaSettings>): Promise<void> {
  await swell.put(`/settings/${appId}`, { katana: values });
}
