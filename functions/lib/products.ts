// Swell → Katana product export: creates Katana products (with their variants) for Swell products with
// stock tracking on, matched by SKU, and sets Katana's starting stock to the Swell stock level.
// Safe to run again: SKUs already in Katana aren't created twice, and stock is only set where Katana has none.

import {
  KatanaInventory,
  KatanaSettings,
  KatanaVariant,
  createProduct,
  createStockAdjustment,
  createVariant,
  findVariantsBySku,
  listInventoryForVariants,
} from './katana';

// one sellable item of a Swell product: the product itself, or one of its variants
export interface ProductItem {
  sku: string;
  name: string;
  stock_level: number;
  price: number | null;
  cost: number | null;
  config_attributes: { config_name: string; config_value: string }[];
}

export interface ExportResult {
  // Katana products created, or existing Katana products that got new variants
  created: boolean;
  variants_created: number;
  // Katana variants whose starting stock was set
  adjusted: number;
}

export class ProductExportError extends Error {}

const money = (value: unknown): number | null => {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) || n < 0 ? null : n;
};

export function isVariable(product: any): boolean {
  return (product?.options || []).some((option: any) => option?.variant);
}

// The items of a Swell product that can go to Katana, and how many have no SKU
export function productItems(
  product: any,
  variants: any[] = [],
): { items: ProductItem[]; skipped: number } {
  if (!isVariable(product)) {
    if (!product.sku) {
      return { items: [], skipped: 1 };
    }
    return {
      items: [
        {
          sku: String(product.sku),
          name: product.name,
          stock_level: Math.max(0, Math.floor(Number(product.stock_level) || 0)),
          price: money(product.price),
          cost: money(product.cost),
          config_attributes: [],
        },
      ],
      skipped: 0,
    };
  }

  const options = (product.options || []).filter((option: any) => option?.variant);
  const items: ProductItem[] = [];
  let skipped = 0;
  for (const variant of variants) {
    if (!variant.sku) {
      skipped++;
      continue;
    }
    const valueIds: string[] = variant.option_value_ids || [];
    const config_attributes = options
      .map((option: any) => {
        const value = (option.values || []).find((v: any) => valueIds.includes(v.id));
        return value ? { config_name: String(option.name), config_value: String(value.name) } : null;
      })
      .filter(Boolean) as ProductItem['config_attributes'];
    items.push({
      sku: String(variant.sku),
      name: variant.name || product.name,
      stock_level: Math.max(0, Math.floor(Number(variant.stock_level) || 0)),
      price: money(variant.price ?? product.price),
      cost: money(variant.cost ?? product.cost),
      config_attributes,
    });
  }
  return { items, skipped };
}

function variantBody(item: ProductItem) {
  return {
    sku: item.sku,
    ...(item.price !== null && { sales_price: item.price }),
    ...(item.cost !== null && { purchase_price: item.cost }),
    ...(item.config_attributes.length && { config_attributes: item.config_attributes }),
  };
}

// Katana product body: one config per Swell variant option, with the values the items use
export function buildKatanaProduct(product: any, items: ProductItem[]) {
  const configs: { name: string; values: string[] }[] = [];
  for (const item of items) {
    for (const { config_name, config_value } of item.config_attributes) {
      let config = configs.find((c) => c.name === config_name);
      if (!config) {
        config = { name: config_name, values: [] };
        configs.push(config);
      }
      if (!config.values.includes(config_value)) {
        config.values.push(config_value);
      }
    }
  }
  return {
    name: String(product.name || items[0]?.sku),
    uom: 'pcs',
    is_sellable: true,
    ...(configs.length && { configs }),
    variants: items.map(variantBody),
  };
}

// Starting stock rows: items with Swell stock whose Katana variant has nothing in stock at the location.
// With "in stock minus committed" the committed quantity is added, so Katana's available stock equals Swell's.
export function startingStockRows(
  items: ProductItem[],
  variantsBySku: Map<string, KatanaVariant>,
  inventory: KatanaInventory[],
  settings: KatanaSettings,
): { variant_id: number; quantity: number; cost_per_unit?: number }[] {
  const rows = [];
  for (const item of items) {
    const variant = variantsBySku.get(item.sku);
    if (!variant || item.stock_level <= 0) {
      continue;
    }
    const stock = inventory.find((row) => row.variant_id === variant.id);
    if ((Number(stock?.quantity_in_stock) || 0) !== 0) {
      continue;
    }
    const committed = settings.stock_quantity === 'in_stock' ? 0 : Math.max(0, Number(stock?.quantity_committed) || 0);
    rows.push({
      variant_id: variant.id,
      quantity: item.stock_level + committed,
      ...(item.cost !== null && { cost_per_unit: item.cost }),
    });
  }
  return rows;
}

// Creates the Katana product or its missing variants, then sets the starting stock
export async function exportProduct(
  settings: KatanaSettings,
  product: any,
  items: ProductItem[],
  known: Map<string, KatanaVariant>,
): Promise<ExportResult> {
  const result: ExportResult = { created: false, variants_created: 0, adjusted: 0 };
  const missing = items.filter((item) => !known.has(item.sku));
  const existing = items.map((item) => known.get(item.sku)).filter(Boolean) as KatanaVariant[];

  if (missing.length) {
    if (!existing.length) {
      await createProduct(settings, buildKatanaProduct(product, missing));
    } else {
      const productId = existing.find((variant) => variant.product_id)?.product_id;
      if (!productId) {
        throw new ProductExportError(`SKU ${existing[0].sku} is a Katana material, not a product`);
      }
      for (const item of missing) {
        await createVariant(settings, { product_id: productId, ...variantBody(item) });
      }
    }
    result.created = true;
    result.variants_created = missing.length;
  }

  // read the new variants' IDs back by SKU
  const variantsBySku = new Map(known);
  if (missing.length) {
    const created = await findVariantsBySku(settings, missing.map((item) => item.sku));
    for (const [sku, variant] of created) {
      variantsBySku.set(sku, variant);
    }
    const notFound = missing.filter((item) => !created.has(item.sku));
    if (notFound.length) {
      throw new ProductExportError(`Katana didn't return the new SKUs: ${notFound.map((item) => item.sku).join(', ')}`);
    }
  }

  const withStock = items.filter((item) => item.stock_level > 0 && variantsBySku.has(item.sku));
  if (!withStock.length) {
    return result;
  }
  const inventory = await listInventoryForVariants(settings, withStock.map((item) => variantsBySku.get(item.sku)!.id));
  const rows = startingStockRows(withStock, variantsBySku, inventory, settings);
  if (rows.length) {
    await createStockAdjustment(settings, {
      location_id: Number(settings.location_id),
      stock_adjustment_rows: rows,
      stock_adjustment_date: new Date().toISOString(),
      reason: 'Starting stock from Swell',
      additional_info: `Swell product ${product.name} (${product.id})`,
    });
    result.adjusted = rows.length;
  }
  return result;
}
