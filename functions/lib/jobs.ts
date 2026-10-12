// Katana sync jobs (`apps/katana/syncs`): long syncs split into steps. Each step reads one page, applies
// it and saves its progress; saving re-triggers `sync-run` for the next step until the job completes.

import { KatanaError, findVariantsBySku, getAppData, isRetryable, listInventory, syncPageSize } from './katana';
import { DuplicateSkuError, SkuError, katanaItems } from './mapping';
import { SyncContext, sendOrder } from './orders';
import { exportProduct, isVariable, productItems } from './products';
import { applyInventory, findStockTargets, mergeSkus, reportPush } from './stock';

export type JobType = 'inventory' | 'orders' | 'products';

// a record of `apps/katana/syncs`
export interface Job {
  id: string;
  type: JobType;
  trigger?: 'manual' | 'schedule';
  status: string;
  date_from?: string | null;
  page?: number | null;
  last_id?: string | null;
  pages?: number;
  checked?: number;
  changed?: number;
  skipped?: number;
  not_found?: number;
  failed?: number;
  adjusted?: number;
  report_rows?: number;
  total?: number | null;
  retries?: number;
  date_started?: string | null;
  [key: string]: any;
}

export type JobUpdate = Record<string, any>;

// result of one step: progress to save, and the retryable error that stopped it early, if any
export interface StepResult {
  update: JobUpdate;
  error?: unknown;
}

export const ACTIVE_STATUSES = ['pending', 'running', 'waiting'];
export const JOB_LABELS: Record<JobType, string> = {
  inventory: 'Stock sync',
  orders: 'Order sync',
  products: 'Product export',
};

// Stop starting new work after this long, well within the function's time limit
export const STEP_BUDGET_MS = 7000;
// Automatic retries after rate limits and Katana outages before a job fails
export const MAX_RETRIES = 8;

// Katana asks for a pause after a 429; other errors back off 1, 2, 4 ... up to 30 minutes
export function retryDelaySeconds(err: unknown, attempt: number): number {
  if (err instanceof KatanaError && err.status === 429) {
    return 60;
  }
  return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 1800);
}

// Each recorded step re-triggers sync-run for the next one. Edits to other fields don't.
export function shouldRun(data: SwellData): boolean {
  const event = data.$event;
  if (event?.type === 'sync.created') {
    return true;
  }
  const changed = event?.data || {};
  return 'pages' in changed || changed.status === 'pending';
}

// The active job of a type, if any
export async function activeJob(swell: SwellAPI, type: JobType): Promise<Job | null> {
  const result = await swell.get('/syncs', {
    where: { type, status: { $in: ACTIVE_STATUSES } },
    sort: 'date_created asc',
    limit: 1,
  });
  return result?.results?.[0] || null;
}

// Starts a job unless one of the same type is already active
export async function startJob(
  swell: SwellAPI,
  type: JobType,
  fields: Record<string, unknown> = {},
): Promise<{ job: Job; started: boolean }> {
  const active = await activeJob(swell, type);
  if (active) {
    return { job: active, started: false };
  }
  const job = await swell.post('/syncs', { type, status: 'pending', trigger: 'manual', ...fields });
  return { job, started: true };
}

const add = (job: Job, key: string, value: number) => (Number(job[key]) || 0) + value;

// One step of a stock sync: one page of Katana inventory at the location, applied to Swell stock.
// A page cut short by the time budget is read again next step; stock adjustments are idempotent.
export async function inventoryStep(ctx: SyncContext, job: Job, deadline: number): Promise<StepResult> {
  const { swell, settings } = ctx;
  const limit = syncPageSize(settings);
  const page = Math.max(1, Number(job.page) || 1);

  const rows = await listInventory(settings, { page, limit });
  const result = await applyInventory(swell, rows, settings, ctx.appValues, deadline);

  const update: JobUpdate = {
    pages: add(job, 'pages', 1),
    checked: add(job, 'checked', result.checked),
    changed: add(job, 'changed', result.updated),
    skipped: add(job, 'skipped', result.skipped),
    not_found: add(job, 'not_found', result.unmatched),
    report_rows: add(job, 'report_rows', result.changes.length),
    last_error: null,
    ...reportPush(result.changes, job.report_rows),
  };
  if (result.duplicates.length) {
    update.duplicate_skus = mergeSkus(job.duplicate_skus, result.duplicates);
  }
  if (!result.complete) {
    update.page = page;
  } else if (rows.length < limit) {
    update.page = page;
    update.status = 'completed';
  } else {
    update.page = page + 1;
  }
  return { update };
}

// Swell orders an order sync sends: not canceled, not delivered, not sent yet, paid (unless orders go on
// submit), created on or after `date_from`, after `last_id`. Delivered orders would only commit stock in Katana.
export function ordersQuery(ctx: SyncContext, job: Job, limit: number): Record<string, any> {
  const where: Record<string, any> = {
    canceled: { $ne: true },
    delivered: { $ne: true },
    [`$app.${ctx.appId}.katana_sales_order_id`]: null,
  };
  if (ctx.settings.sync_on !== 'submitted') {
    where.paid = true;
  }
  if (job.date_from) {
    where.date_created = { $gte: job.date_from };
  }
  if (job.last_id) {
    where.id = { $gt: job.last_id };
  }
  return {
    where,
    sort: 'id asc',
    limit,
    expand: ['account', 'items.product', 'items.variant'],
  };
}

// One step of an order sync: sends a page of Swell orders to Katana, one by one until the time budget
// runs out. Orders Katana rejects get `katana_error` and are counted as failed; a retryable error
// (rate limit, outage) stops the step with the progress so far.
export async function ordersStep(ctx: SyncContext, job: Job, deadline: number): Promise<StepResult> {
  const { swell } = ctx;
  const limit = syncPageSize(ctx.settings);
  const page = await swell.get('/orders', ordersQuery(ctx, job, limit));
  const orders: any[] = page?.results || [];

  const counts = { checked: 0, changed: 0, skipped: 0, failed: 0 };
  let lastId = job.last_id || null;
  let lastError: string | null = null;
  let error: unknown;

  for (const order of orders) {
    if (Date.now() >= deadline) {
      break;
    }
    counts.checked++;
    if (getAppData(order, ctx.appId).katana_sales_order_id || !katanaItems(order).length) {
      counts.skipped++;
      lastId = order.id;
      continue;
    }
    try {
      await sendOrder(ctx, order);
      counts.changed++;
    } catch (err: any) {
      if (isRetryable(err) && !(err instanceof SkuError)) {
        counts.checked--;
        error = err;
        break;
      }
      const message = err?.message || String(err);
      await swell.put(`/orders/${order.id}`, ctx.appValues({ katana_error: message }));
      counts.failed++;
      lastError = `Order ${order.number}: ${message}`;
    }
    lastId = order.id;
  }

  const handled = orders.findIndex((order) => order.id === lastId) + 1;
  const update: JobUpdate = {
    pages: add(job, 'pages', 1),
    last_id: lastId,
    checked: add(job, 'checked', counts.checked),
    changed: add(job, 'changed', counts.changed),
    skipped: add(job, 'skipped', counts.skipped),
    failed: add(job, 'failed', counts.failed),
    last_error: lastError,
  };
  if (!job.last_id && typeof page?.count === 'number') {
    update.total = page.count;
  }
  if (!error && orders.length < limit && handled === orders.length) {
    update.status = 'completed';
  }
  return { update, error };
}

// Swell products a product export sends: stock tracking on, after `last_id`
export function productsQuery(job: Job, limit: number): Record<string, any> {
  return {
    where: { stock_tracking: true, ...(job.last_id && { id: { $gt: job.last_id } }) },
    sort: 'id asc',
    limit,
    fields: 'id,name,sku,price,cost,stock_level,stock_tracking,options',
  };
}

// One step of a product export: creates Katana products for a page of Swell products with stock tracking
// on, and sets their starting stock. Products Katana rejects get `katana_error` and count as failed; a
// retryable error stops the step with the progress so far.
export async function productsStep(ctx: SyncContext, job: Job, deadline: number): Promise<StepResult> {
  const { swell, settings } = ctx;
  const limit = Math.min(syncPageSize(settings), 100);
  const page = await swell.get('/products', productsQuery(job, limit));
  const products: any[] = page?.results || [];

  const variableIds = products.filter(isVariable).map((product) => product.id);
  const variants: any[] = [];
  for (let variantPage = 1; variableIds.length; variantPage++) {
    const result = await swell.get('/products:variants', {
      where: { parent_id: { $in: variableIds } },
      fields: 'id,parent_id,name,sku,price,cost,stock_level,option_value_ids',
      limit: 1000,
      page: variantPage,
    });
    variants.push(...(result?.results || []));
    if ((result?.results || []).length < 1000) {
      break;
    }
  }

  const prepared = products.map((product) =>
    productItems(product, variants.filter((variant: any) => variant.parent_id === product.id)),
  );
  const skus = prepared.flatMap(({ items }) => items.map((item) => item.sku));
  const known = await findVariantsBySku(settings, skus);
  // SKUs on more than one Swell product or variant can't be matched to one Katana variant
  const { duplicates } = await findStockTargets(swell, skus);

  const counts = { checked: 0, changed: 0, skipped: 0, failed: 0, adjusted: 0 };
  let lastId = job.last_id || null;
  let lastError: string | null = null;
  let error: unknown;

  for (const [index, product] of products.entries()) {
    if (Date.now() >= deadline) {
      break;
    }
    const { items, skipped } = prepared[index];
    counts.skipped += skipped;
    if (!items.length) {
      counts.checked++;
      lastId = product.id;
      continue;
    }
    const duplicated = [...new Set(items.filter((item) => duplicates.has(item.sku)).map((item) => item.sku))];
    if (duplicated.length) {
      const message = new DuplicateSkuError(duplicated).message;
      await swell.put(`/products/${product.id}`, ctx.appValues({ katana_error: `Product export: ${message}` }));
      counts.checked++;
      counts.failed++;
      lastError = `Product ${product.name}: ${message}`;
      lastId = product.id;
      continue;
    }
    try {
      const result = await exportProduct(settings, product, items, known);
      counts.checked++;
      if (result.created) counts.changed++;
      counts.adjusted += result.adjusted;
      await swell.put(`/products/${product.id}`, ctx.appValues({ katana_error: null }));
    } catch (err: any) {
      if (isRetryable(err) && err instanceof KatanaError) {
        counts.skipped -= skipped;
        error = err;
        break;
      }
      const message = err?.message || String(err);
      await swell.put(`/products/${product.id}`, ctx.appValues({ katana_error: `Product export: ${message}` }));
      counts.checked++;
      counts.failed++;
      lastError = `Product ${product.name}: ${message}`;
    }
    lastId = product.id;
  }

  const handled = products.findIndex((product) => product.id === lastId) + 1;
  const update: JobUpdate = {
    pages: add(job, 'pages', 1),
    last_id: lastId,
    checked: add(job, 'checked', counts.checked),
    changed: add(job, 'changed', counts.changed),
    skipped: add(job, 'skipped', counts.skipped),
    failed: add(job, 'failed', counts.failed),
    adjusted: add(job, 'adjusted', counts.adjusted),
    last_error: lastError,
  };
  if (!job.last_id && typeof page?.count === 'number') {
    update.total = page.count;
  }
  if (!error && products.length < limit && handled === products.length) {
    update.status = 'completed';
  }
  return { update, error };
}

export async function runStep(ctx: SyncContext, job: Job, deadline: number): Promise<StepResult> {
  switch (job.type) {
    case 'inventory':
      return inventoryStep(ctx, job, deadline);
    case 'orders':
      return ordersStep(ctx, job, deadline);
    case 'products':
      return productsStep(ctx, job, deadline);
    default:
      throw new Error(`Unknown sync type: ${job.type}`);
  }
}
