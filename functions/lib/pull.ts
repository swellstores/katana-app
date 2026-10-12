// Katana → Swell checks: every 5 minutes, read what changed in Katana since the previous check of each
// source and apply it to Swell. A check that changes something (or must continue on the next run) is
// logged in `apps/katana/pulls`; a check that finds nothing writes only its checkpoint.

import {
  KatanaSettings,
  isRetryable,
  listChangedSalesOrders,
  listInventoryForVariants,
  listInventoryMovements,
} from './katana';
import { SyncContext, applySalesOrder } from './orders';
import { StockChange, applyInventory, mergeSkus, reportPush, saveSyncState } from './stock';

export type PullSource = 'sales_orders' | 'inventory';

// katana-poll runs every 5 minutes (its cron schedule)
export const PULL_INTERVAL_MS = 5 * 60_000;
// Stop starting new work after this long, well within the function's time limit
export const TIME_BUDGET_MS = 7000;
// A source's first check looks back this far
export const FIRST_LOOKBACK_MS = 60 * 60_000;
// Changes this long before the previous check started are read again, so nothing saved while it ran is missed
export const OVERLAP_MS = 60_000;

export const SALES_ORDER_PAGE = 100;
export const MOVEMENT_PAGE = 250;

// settings field holding the start of each source's last completed check
export const CHECKED_AT: Record<PullSource, 'orders_checked_at' | 'stock_checked_at'> = {
  sales_orders: 'orders_checked_at',
  inventory: 'stock_checked_at',
};

export const SOURCE_LABELS: Record<PullSource, string> = { sales_orders: 'Sales orders', inventory: 'Stock' };

// A record of `apps/katana/pulls`
export interface PullRun {
  id?: string;
  source: PullSource;
  status?: 'running' | 'completed';
  changed?: number;
  not_found?: number;
  failed?: number;
  date_cursor?: string | null;
  date_pass_started?: string | null;
  page?: number | null;
  [key: string]: any;
}

export interface PullResult {
  source: PullSource;
  cursor: string;
  complete: boolean;
  changed: number;
  not_found: number;
  failed: number;
  // stock checks: moved SKUs used by more than one Swell product or variant
  duplicate_skus?: string[];
  last_error?: string;
  run?: PullRun;
}

interface PageOutcome {
  // every item of the page was applied
  complete: boolean;
  // the page was the last one
  last: boolean;
}

interface Counts {
  changed: number;
  not_found: number;
  failed: number;
  last_error?: string;
  // stock checks: the Swell stock levels changed
  changes?: StockChange[];
  // stock checks: moved SKUs used by more than one Swell product or variant
  duplicate_skus?: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();

// Sources checked: sales orders always, stock when inventory sync is on
export function pullSources(settings: KatanaSettings): PullSource[] {
  return settings.sync_inventory === false ? ['sales_orders'] : ['sales_orders', 'inventory'];
}

// Where a new check starts reading: the previous completed check minus the overlap, or the look-back window
export function checkCursor(settings: KatanaSettings, source: PullSource, nowMs: number): string {
  const last = Date.parse(settings[CHECKED_AT[source]] || '');
  return iso(Number.isNaN(last) ? nowMs - FIRST_LOOKBACK_MS : last - OVERLAP_MS);
}

// The source's latest logged check, if any
export async function latestPull(swell: SwellAPI, source: PullSource): Promise<PullRun | undefined> {
  const result = await swell.get('/pulls', { where: { source }, sort: 'date_created desc', limit: 1 });
  return result?.results?.[0];
}

// One page of sales orders changed since `cursor`: status and tracking copied to their Swell orders
async function salesOrdersPage(
  ctx: SyncContext,
  cursor: string,
  page: number,
  deadline: number,
  now: () => number,
  counts: Counts,
): Promise<PageOutcome> {
  const salesOrders = await listChangedSalesOrders(ctx.settings, cursor, page, SALES_ORDER_PAGE);
  for (const salesOrder of salesOrders) {
    if (now() >= deadline) {
      return { complete: false, last: false };
    }
    try {
      const outcome = await applySalesOrder(ctx, salesOrder);
      if (outcome === 'updated') {
        counts.changed++;
      } else if (outcome === 'not_found') {
        counts.not_found++;
      }
    } catch (err: any) {
      if (isRetryable(err)) {
        throw err;
      }
      counts.failed++;
      counts.last_error = `Sales order ${salesOrder.order_no}: ${err?.message || err}`;
    }
  }
  return { complete: true, last: salesOrders.length < SALES_ORDER_PAGE };
}

// One page of stock movements since `cursor`: current stock of the moved variants copied to Swell
async function inventoryPage(
  ctx: SyncContext,
  cursor: string,
  page: number,
  deadline: number,
  counts: Counts,
): Promise<PageOutcome> {
  const movements = await listInventoryMovements(ctx.settings, cursor, page, MOVEMENT_PAGE);
  const last = movements.length < MOVEMENT_PAGE;
  const variantIds = [...new Set(movements.map((movement) => movement.variant_id))];
  if (!variantIds.length) {
    return { complete: true, last };
  }
  const rows = await listInventoryForVariants(ctx.settings, variantIds);
  const applied = await applyInventory(ctx.swell, rows, ctx.settings, ctx.appValues, deadline);
  counts.changed += applied.updated;
  counts.changes = [...(counts.changes || []), ...applied.changes];
  counts.not_found += applied.unmatched;
  if (applied.duplicates.length) {
    counts.duplicate_skus = mergeSkus(counts.duplicate_skus, applied.duplicates);
  }
  return { complete: applied.complete, last };
}

// Checks one source. A running check (out of time, or stopped by an error) keeps its cursor and page
// and continues on the next run; a completed one saves its start time as the next checkpoint.
export async function pullSource(
  ctx: SyncContext,
  source: PullSource,
  latest: PullRun | undefined,
  deadline: number,
  now: () => number = Date.now,
): Promise<PullResult> {
  const { swell } = ctx;
  const resume = latest?.status === 'running' ? latest : undefined;
  const passStart = resume?.date_pass_started || iso(now());
  const cursor = resume?.date_cursor || checkCursor(ctx.settings, source, Date.parse(passStart));
  let page = Math.max(1, Number(resume?.page) || 1);
  const counts: Counts = { changed: 0, not_found: 0, failed: 0, ...(source === 'inventory' && { changes: [] }) };
  let done = false;

  try {
    while (now() < deadline) {
      const outcome =
        source === 'sales_orders'
          ? await salesOrdersPage(ctx, cursor, page, deadline, now, counts)
          : await inventoryPage(ctx, cursor, page, deadline, counts);
      // a page cut short is read again; its applied items compare equal then
      if (!outcome.complete) {
        break;
      }
      if (outcome.last) {
        done = true;
        break;
      }
      page++;
    }
  } catch (err: any) {
    counts.last_error = `${SOURCE_LABELS[source]}: ${err?.message || err}`;
  }

  const result: PullResult = { source, cursor, complete: done, ...counts };

  if (done) {
    await saveSyncState(swell, ctx.appId, { [CHECKED_AT[source]]: passStart });
  }

  // SKUs Katana moves that aren't in Swell (e.g. raw materials) are common, so they alone aren't logged
  const notable =
    counts.changed > 0 ||
    counts.failed > 0 ||
    (source === 'sales_orders' && counts.not_found > 0) ||
    Boolean(counts.duplicate_skus?.length);
  if (!resume && !notable && done) {
    return result;
  }

  const save: Record<string, any> = {
    changed: (resume?.changed || 0) + counts.changed,
    not_found: (resume?.not_found || 0) + counts.not_found,
    failed: (resume?.failed || 0) + counts.failed,
  };
  const changes = counts.changes || [];
  if (source === 'inventory') {
    save.report_rows = (resume?.report_rows || 0) + changes.length;
  }
  if (counts.duplicate_skus?.length) {
    save.duplicate_skus = mergeSkus(resume?.duplicate_skus, counts.duplicate_skus);
  }
  if (done) {
    Object.assign(save, { status: 'completed', page: null, date_completed: iso(now()) });
  } else {
    Object.assign(save, { status: 'running', page });
  }
  if (counts.last_error) {
    Object.assign(save, { last_error: counts.last_error, date_last_error: iso(now()) });
    console.error(`Katana: check failed - ${counts.last_error}`);
  }

  if (resume?.id) {
    await swell.put(`/pulls/${resume.id}`, { ...save, ...reportPush(changes, resume.report_rows) });
    result.run = { ...resume, ...save };
  } else {
    const report = reportPush(changes).$push?.report.$each;
    result.run = await swell.post('/pulls', {
      source,
      date_cursor: cursor,
      date_pass_started: passStart,
      ...save,
      ...(report && { report }),
    });
  }
  return result;
}

// Checks every source within the time budget. The first source changes every run, so one busy source
// can't starve the other.
export async function runChecks(
  ctx: SyncContext,
  budgetMs = TIME_BUDGET_MS,
  now: () => number = Date.now,
): Promise<PullResult[]> {
  const started = now();
  const deadline = started + budgetMs;
  const sources = pullSources(ctx.settings);
  const first = Math.floor(started / PULL_INTERVAL_MS) % sources.length;
  const order = [...sources.slice(first), ...sources.slice(0, first)];

  const results: PullResult[] = [];
  for (const source of order) {
    if (now() >= deadline) {
      break;
    }
    results.push(await pullSource(ctx, source, await latestPull(ctx.swell, source), deadline, now));
  }
  return results;
}

// Plain-language summary of a check, for the "Check Katana now" action
export function describeChecks(settings: KatanaSettings, results: PullResult[]): string {
  const parts = pullSources(settings).map((source) => {
    const result = results.find((r) => r.source === source);
    if (!result) {
      return `${SOURCE_LABELS[source]}: not checked this time, the next check runs it.`;
    }
    const counts =
      source === 'sales_orders'
        ? `${result.changed} Swell orders updated, ${result.not_found} sales orders without a Swell order`
        : `${result.changed} Swell stock levels changed, ${result.not_found} moved SKUs not in Swell`;
    const duplicates = result.duplicate_skus?.length
      ? `, not synced because more than one Swell product or variant uses the SKU: ${result.duplicate_skus.join(', ')}`
      : '';
    const failed = result.failed ? `, ${result.failed} failed (${result.last_error})` : '';
    const status = result.complete
      ? ''
      : ` Not finished${result.last_error && !result.failed ? ` (${result.last_error})` : ''}; the next check continues.`;
    return `${SOURCE_LABELS[source]} changed since ${result.cursor}: ${counts}${duplicates}${failed}.${status}`;
  });
  return parts.join(' ');
}
