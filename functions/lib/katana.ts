const API_BASE = 'https://api.katanamrp.com/v1';

// longest Retry-After we wait out inside one function run (functions time out at 10s)
const MAX_RETRY_WAIT_MS = 3000;

// sales order statuses that can still be deleted / edited in Katana
export const OPEN_STATUSES = ['NOT_SHIPPED', 'PENDING'];

export interface KatanaSettings {
  api_key?: string;
  location_id?: number;
  tax_rate_id?: number;
  sync_on?: 'paid' | 'submitted';
  order_no_prefix?: string;
  on_cancel?: 'delete' | 'none';
  create_fulfillment?: boolean;
  sync_inventory?: boolean;
  stock_quantity?: 'available' | 'in_stock';
  sync_page_size?: number;
  orders_checked_at?: string;
  stock_checked_at?: string;
  enabled?: boolean;
}

export interface KatanaVariant {
  id: number;
  sku?: string | null;
  product_id?: number | null;
  type?: string;
}

export interface KatanaCustomer {
  id: number;
  name?: string;
  email?: string | null;
}

export interface KatanaSalesOrder {
  id: number;
  order_no: string;
  customer_id: number;
  status: string;
  location_id?: number;
  tracking_number?: string | null;
  tracking_number_url?: string | null;
  ecommerce_order_id?: string | null;
  ecommerce_store_name?: string | null;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface KatanaFulfillment {
  id: number;
  sales_order_id: number;
  status?: string;
  tracking_number?: string | null;
  tracking_url?: string | null;
  tracking_carrier?: string | null;
  tracking_method?: string | null;
}

export interface KatanaInventory {
  variant_id: number;
  location_id: number;
  quantity_in_stock?: string | number | null;
  quantity_committed?: string | number | null;
  variant?: KatanaVariant;
}

export interface KatanaMovement {
  id: number;
  variant_id: number;
  location_id: number;
  created_at?: string;
}

export class KatanaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'KatanaError';
    this.status = status;
  }
}

// errors worth retrying later (event-triggered functions are retried by the platform when they throw)
export function isRetryable(err: unknown): boolean {
  if (err instanceof KatanaError) {
    return err.status === 429 || err.status >= 500;
  }
  return true;
}

export async function getKatanaSettings(swell: SwellAPI): Promise<KatanaSettings> {
  const all = await swell.settings();
  return all?.katana || {};
}

export function hasCredentials(settings: KatanaSettings): boolean {
  return Boolean(settings.api_key?.trim() && settings.location_id);
}

// rows or orders per sync job step: 1-250, default 50 (product exports use at most 100)
export function syncPageSize(settings: KatanaSettings): number {
  const size = Math.floor(Number(settings.sync_page_size));
  return Number.isFinite(size) && size > 0 ? Math.min(size, 250) : 50;
}

// arrays become repeated keys (sku=A&sku=B), which is how Katana reads array filters
export function buildQuery(query: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

// Katana errors come as { message, details } or wrapped in { error: { message, details } }
export function errorMessage(json: any, text: string, statusText: string): string {
  const error = json?.error && typeof json.error === 'object' ? json.error : json;
  const details = Array.isArray(error?.details)
    ? error.details.map((d: any) => [d.path, d.message].filter(Boolean).join(' ')).join('; ')
    : '';
  return [error?.message, details].filter(Boolean).join(': ') || text || statusText;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function katanaRequest(
  settings: KatanaSettings,
  method: string,
  path: string,
  options: { query?: Record<string, unknown>; body?: unknown } = {},
  attempt = 0,
): Promise<any> {
  const res = await fetch(`${API_BASE}${path}${buildQuery(options.query)}`, {
    method,
    headers: {
      Authorization: `Bearer ${settings.api_key?.trim()}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // rate limit is 60 requests / 60s; wait once if Katana asks for a short pause
  if (res.status === 429 && attempt === 0) {
    const waitMs = Number(res.headers.get('retry-after') || 0) * 1000;
    if (waitMs > 0 && waitMs <= MAX_RETRY_WAIT_MS) {
      await sleep(waitMs);
      return katanaRequest(settings, method, path, options, attempt + 1);
    }
  }

  if (res.status === 204) {
    return null;
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    throw new KatanaError(`Katana ${res.status}: ${errorMessage(json, text, res.statusText)}`, res.status);
  }

  return json;
}

// --- resources ---

const SKU_CHUNK = 50;

// Katana variants for the given SKUs, keyed by SKU
export async function findVariantsBySku(
  settings: KatanaSettings,
  skus: string[],
): Promise<Map<string, KatanaVariant>> {
  const unique = [...new Set(skus.filter(Boolean))];
  const result = new Map<string, KatanaVariant>();

  for (let i = 0; i < unique.length; i += SKU_CHUNK) {
    const chunk = unique.slice(i, i + SKU_CHUNK);
    const res = await katanaRequest(settings, 'GET', '/variants', {
      query: { sku: chunk, limit: 250 },
    });
    for (const variant of res?.data || []) {
      if (variant.sku) {
        result.set(variant.sku, variant);
      }
    }
  }

  return result;
}

export async function findCustomerByEmail(
  settings: KatanaSettings,
  email: string,
): Promise<KatanaCustomer | null> {
  const res = await katanaRequest(settings, 'GET', '/customers', { query: { email, limit: 1 } });
  return res?.data?.[0] || null;
}

export async function createCustomer(settings: KatanaSettings, customer: object): Promise<KatanaCustomer> {
  return katanaRequest(settings, 'POST', '/customers', { body: customer });
}

export async function findSalesOrderByEcommerceId(
  settings: KatanaSettings,
  ecommerceOrderId: string,
): Promise<KatanaSalesOrder | null> {
  const res = await katanaRequest(settings, 'GET', '/sales_orders', {
    query: { ecommerce_order_id: ecommerceOrderId, limit: 1 },
  });
  return res?.data?.[0] || null;
}

export async function createSalesOrder(settings: KatanaSettings, salesOrder: object): Promise<KatanaSalesOrder> {
  return katanaRequest(settings, 'POST', '/sales_orders', { body: salesOrder });
}

export async function getSalesOrder(settings: KatanaSettings, id: number): Promise<KatanaSalesOrder> {
  return katanaRequest(settings, 'GET', `/sales_orders/${id}`);
}

export async function deleteSalesOrder(settings: KatanaSettings, id: number): Promise<void> {
  await katanaRequest(settings, 'DELETE', `/sales_orders/${id}`);
}

export async function addShippingFee(
  settings: KatanaSettings,
  fee: { sales_order_id: number; amount: string; description?: string; tax_rate_id?: number },
): Promise<void> {
  await katanaRequest(settings, 'POST', '/sales_order_shipping_fee', { body: fee });
}

export async function listFulfillments(settings: KatanaSettings, salesOrderId: number): Promise<KatanaFulfillment[]> {
  const res = await katanaRequest(settings, 'GET', '/sales_order_fulfillments', {
    query: { sales_order_id: salesOrderId, limit: 50 },
  });
  return res?.data || [];
}

export async function listInventory(
  settings: KatanaSettings,
  options: { variantIds?: number[]; page?: number; limit?: number } = {},
): Promise<KatanaInventory[]> {
  const res = await katanaRequest(settings, 'GET', '/inventory', {
    query: {
      location_id: settings.location_id,
      variant_id: options.variantIds,
      extend: 'variant',
      page: options.page,
      limit: options.limit,
    },
  });
  return res?.data || [];
}

export async function createProduct(settings: KatanaSettings, product: object): Promise<{ id: number; variants?: KatanaVariant[] }> {
  return katanaRequest(settings, 'POST', '/products', { body: product });
}

export async function createVariant(settings: KatanaSettings, variant: object): Promise<KatanaVariant> {
  return katanaRequest(settings, 'POST', '/variants', { body: variant });
}

export async function createStockAdjustment(
  settings: KatanaSettings,
  adjustment: {
    location_id: number;
    stock_adjustment_rows: { variant_id: number; quantity: number; cost_per_unit?: number }[];
    stock_adjustment_date?: string;
    reason?: string;
    additional_info?: string;
  },
): Promise<{ id: number }> {
  return katanaRequest(settings, 'POST', '/stock_adjustments', { body: adjustment });
}

export async function listLocations(settings: KatanaSettings): Promise<any[]> {
  const res = await katanaRequest(settings, 'GET', '/locations', { query: { limit: 100 } });
  return res?.data || [];
}

export async function listTaxRates(settings: KatanaSettings): Promise<any[]> {
  const res = await katanaRequest(settings, 'GET', '/tax_rates', { query: { limit: 100 } });
  return res?.data || [];
}

// --- polling ---

// sales orders this app created that changed since `since` (deleted ones included)
export async function listChangedSalesOrders(
  settings: KatanaSettings,
  since: string,
  page = 1,
  limit = 100,
): Promise<KatanaSalesOrder[]> {
  const res = await katanaRequest(settings, 'GET', '/sales_orders', {
    query: { ecommerce_order_type: 'swell', updated_at_min: since, include_deleted: true, page, limit },
  });
  return res?.data || [];
}

// stock movements at the configured location created since `since`
export async function listInventoryMovements(
  settings: KatanaSettings,
  since: string,
  page = 1,
  limit = 250,
): Promise<KatanaMovement[]> {
  const res = await katanaRequest(settings, 'GET', '/inventory_movements', {
    query: { location_id: settings.location_id, created_at_min: since, page, limit },
  });
  return res?.data || [];
}

const VARIANT_CHUNK = 50;

// current inventory at the configured location for the given variants
export async function listInventoryForVariants(settings: KatanaSettings, variantIds: number[]): Promise<KatanaInventory[]> {
  const unique = [...new Set(variantIds)];
  const rows: KatanaInventory[] = [];
  for (let i = 0; i < unique.length; i += VARIANT_CHUNK) {
    const chunk = unique.slice(i, i + VARIANT_CHUNK);
    rows.push(...(await listInventory(settings, { variantIds: chunk, limit: 250 })));
  }
  return rows;
}


// app values on a standard record are keyed by app slug in responses
export function getAppData(record: any, appId: string): Record<string, any> {
  return record?.$app?.[appId] || record?.$app?.katana || {};
}
