import type { KatanaInventory, KatanaSettings, KatanaVariant } from './katana';

// items sent to Katana
export function katanaItems(order: any): any[] {
  return (order?.items || []).filter(
    (item: any) => item.delivery === 'shipment' || (!item.delivery && item.product?.stock_tracking === true),
  );
}

export function itemSku(item: any): string | undefined {
  const sku = item?.variant?.sku || item?.sku || item?.product?.sku;
  return typeof sku === 'string' && sku.trim() ? sku.trim() : undefined;
}

export function orderNo(order: any, settings: KatanaSettings): string {
  const prefix = settings.order_no_prefix ?? 'SW-';
  return `${prefix}${order.number}`;
}

function money(value: unknown): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function fullName(address: any): string {
  return (address?.name || `${address?.first_name || ''} ${address?.last_name || ''}`).trim();
}

export function formatAddress(address: any, entityType: 'billing' | 'shipping') {
  if (!address?.address1 && !address?.city && !fullName(address)) {
    return undefined;
  }

  const [first, ...rest] = fullName(address).split(/\s+/);
  return {
    entity_type: entityType,
    first_name: address.first_name || first || null,
    last_name: address.last_name || rest.join(' ') || null,
    company: address.company || null,
    phone: address.phone || null,
    line_1: address.address1 || null,
    line_2: address.address2 || null,
    city: address.city || null,
    state: address.state || null,
    zip: address.zip || null,
    country: address.country ? String(address.country).toUpperCase() : null,
  };
}

// POST /customers body for the order's customer
export function buildCustomer(order: any): Record<string, unknown> {
  const account = order.account || {};
  const billing = order.billing?.address1 ? order.billing : order.shipping;
  const email = account.email || order.account_email || undefined;
  const name = account.name || fullName(billing) || fullName(order.shipping) || email || `Swell order ${order.number}`;
  const addresses = [formatAddress(order.billing, 'billing'), formatAddress(order.shipping, 'shipping')].filter(Boolean);

  return {
    name,
    first_name: account.first_name || billing?.first_name || undefined,
    last_name: account.last_name || billing?.last_name || undefined,
    company: billing?.company || undefined,
    email,
    phone: account.phone || billing?.phone || undefined,
    currency: order.currency || undefined,
    reference_id: account.id ? String(account.id).slice(0, 100) : undefined,
    ...(addresses.length && { addresses }),
  };
}

export class MissingSkuError extends Error {
  skus: string[];
  constructor(skus: string[]) {
    super(`Not found in Katana (by SKU): ${skus.join(', ')}`);
    this.name = 'MissingSkuError';
    this.skus = skus;
  }
}

// every item sent to Katana needs a SKU that exists in Katana; returns the item names/SKUs that don't
export function findMissingSkus(items: any[], variantsBySku: Map<string, KatanaVariant>): string[] {
  const missing: string[] = [];
  for (const item of items) {
    const sku = itemSku(item);
    if (!sku) {
      missing.push(`${item.product?.name || item.product_name || item.product_id} (no SKU)`);
    } else if (!variantsBySku.has(sku)) {
      missing.push(sku);
    }
  }
  return missing;
}

// POST /sales_orders body for one Swell order
export function buildSalesOrder(
  order: any,
  options: {
    settings: KatanaSettings;
    customerId: number;
    variantsBySku: Map<string, KatanaVariant>;
    storeId: string;
  },
): Record<string, unknown> {
  const { settings, customerId, variantsBySku, storeId } = options;
  const items = katanaItems(order);

  const missing = findMissingSkus(items, variantsBySku);
  if (missing.length) {
    throw new MissingSkuError(missing);
  }

  const rows = items.map((item: any) => {
    const variant = variantsBySku.get(itemSku(item) as string) as KatanaVariant;
    const discount = money(item.discount_total);
    return {
      variant_id: variant.id,
      quantity: Number(item.quantity) || 1,
      price_per_unit: money(item.price),
      ...(discount > 0 && { total_discount: discount }),
      ...(settings.tax_rate_id && { tax_rate_id: Number(settings.tax_rate_id) }),
      location_id: Number(settings.location_id),
    };
  });

  const addresses = [formatAddress(order.billing, 'billing'), formatAddress(order.shipping, 'shipping')].filter(Boolean);

  return {
    order_no: orderNo(order, settings),
    customer_id: customerId,
    location_id: Number(settings.location_id),
    sales_order_rows: rows,
    ...(addresses.length && { addresses }),
    ...(order.currency && { currency: order.currency }),
    ...(order.date_created && { order_created_date: order.date_created }),
    customer_ref: String(order.number),
    ...(order.comments && { additional_info: String(order.comments) }),
    ecommerce_order_type: 'swell',
    ecommerce_store_name: storeId,
    ecommerce_order_id: String(order.id),
  };
}

// shipping fee added after the sales order is created, or null when the order ships free
export function buildShippingFee(order: any, salesOrderId: number, settings: KatanaSettings) {
  const amount = money(order.shipment_price ?? order.shipment_total);
  if (amount <= 0) {
    return null;
  }
  return {
    sales_order_id: salesOrderId,
    amount: amount.toFixed(2),
    description: order.shipping?.service_name || 'Shipping',
    ...(settings.tax_rate_id && { tax_rate_id: Number(settings.tax_rate_id) }),
  };
}

// whole units Swell should have for a Katana inventory row
export function stockTarget(row: KatanaInventory, mode: KatanaSettings['stock_quantity']): number {
  const inStock = Number(row.quantity_in_stock) || 0;
  const committed = Number(row.quantity_committed) || 0;
  const quantity = mode === 'in_stock' ? inStock : inStock - committed;
  return Math.floor(quantity + 1e-9);
}
