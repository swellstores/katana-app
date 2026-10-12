import {
  KatanaSettings,
  getAppData,
  getKatanaSettings,
  hasCredentials,
  listLocations,
  listTaxRates,
} from './lib/katana';
import { katanaItems } from './lib/mapping';
import { getOrder, sendOrder } from './lib/orders';
import { JOB_LABELS, JobType, startJob } from './lib/jobs';
import { describeChecks, runChecks } from './lib/pull';

export const config: SwellConfig = {
  description: 'App actions: test connection, check Katana now, start stock, order or product syncs, send order',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const actionId: string | undefined = data.$action?.id;

  const settings = await getKatanaSettings(swell);
  if (!settings.api_key?.trim()) {
    return { message: 'Enter the Katana API key and save the settings first.' };
  }

  switch (actionId) {
    case 'test_connection':
      return testConnection(settings);
    case 'check_now':
      return checkNow(req, settings);
    case 'sync_inventory':
      return syncInventory(req, settings);
    case 'send_orders':
      return sendOrders(req, settings);
    case 'send_products':
      return sendProducts(req, settings);
    case 'send_order':
      return sendOrderAction(req, settings);
    default:
      throw new SwellError(`Unknown action: ${actionId}`, { status: 400 });
  }
}

async function testConnection(settings: KatanaSettings) {
  const [locations, taxRates] = await Promise.all([listLocations(settings), listTaxRates(settings)]);

  const locationList = locations.map((l: any) => `${l.id} = ${l.name}${l.sales_allowed === false ? ' (sales not allowed)' : ''}`);
  const taxList = taxRates.map((t: any) => `${t.id} = ${t.display_name || t.name}`);

  const problems: string[] = [];
  if (!settings.location_id) {
    problems.push('Location ID is not set.');
  } else if (!locations.some((l: any) => l.id === Number(settings.location_id))) {
    problems.push(`Location ID ${settings.location_id} does not exist in Katana.`);
  }
  if (settings.tax_rate_id && !taxRates.some((t: any) => t.id === Number(settings.tax_rate_id))) {
    problems.push(`Tax rate ID ${settings.tax_rate_id} does not exist in Katana.`);
  }

  return {
    message: [
      problems.length ? `Connected, but: ${problems.join(' ')}` : 'Connected to Katana.',
      `Locations: ${locationList.join(', ') || 'none'}.`,
      `Tax rates: ${taxList.join(', ') || 'none'}.`,
    ].join(' '),
  };
}

async function checkNow(req: SwellRequest, settings: KatanaSettings) {
  if (!hasCredentials(settings)) {
    return { message: 'Set the API key and Location ID first.' };
  }
  const results = await runChecks({
    swell: req.swell,
    appId: req.appId,
    storeId: req.store?.id || '',
    settings,
    appValues: (values) => req.appValues(values),
  });
  return { message: describeChecks(settings, results) };
}

function jobMessage(type: JobType, job: { status: string }, started: boolean) {
  return started
    ? `${JOB_LABELS[type]} started. Follow it under Katana syncs in the dashboard sidebar.`
    : `A ${JOB_LABELS[type].toLowerCase()} is already ${job.status}. Follow it under Katana syncs in the dashboard sidebar.`;
}

async function syncInventory(req: SwellRequest, settings: KatanaSettings) {
  if (!hasCredentials(settings)) {
    return { message: 'Set the API key and Location ID first.' };
  }
  if (settings.sync_inventory === false) {
    return { message: 'Turn on "Sync inventory from Katana" in the app settings first.' };
  }
  const { job, started } = await startJob(req.swell, 'inventory');
  return { message: jobMessage('inventory', job, started) };
}

async function sendOrders(req: SwellRequest, settings: KatanaSettings) {
  if (!hasCredentials(settings)) {
    return { message: 'Set the API key and Location ID first.' };
  }
  const dateFrom = req.data.date_from;
  if (dateFrom && Number.isNaN(Date.parse(dateFrom))) {
    throw new SwellError('Invalid date', { status: 400 });
  }
  const { job, started } = await startJob(req.swell, 'orders', dateFrom ? { date_from: dateFrom } : {});
  return { message: jobMessage('orders', job, started) };
}

async function sendProducts(req: SwellRequest, settings: KatanaSettings) {
  if (!hasCredentials(settings)) {
    return { message: 'Set the API key and Location ID first.' };
  }
  const { job, started } = await startJob(req.swell, 'products');
  return { message: jobMessage('products', job, started) };
}

async function sendOrderAction(req: SwellRequest, settings: KatanaSettings) {
  if (!hasCredentials(settings)) {
    return { message: 'Set the API key and Location ID first.' };
  }

  const orderId = String(req.data.$action?.record_id || '');
  if (!/^[0-9a-f]{24}$/i.test(orderId)) {
    throw new SwellError('Invalid order id', { status: 400 });
  }

  const order = await getOrder(req.swell, orderId);
  if (!order) {
    throw new SwellError('Order not found', { status: 404 });
  }

  const appData = getAppData(order, req.appId);
  if (appData.katana_sales_order_id && appData.katana_status !== 'DELETED') {
    return { message: `Already in Katana as sales order ${appData.katana_order_no}.` };
  }
  if (!katanaItems(order).length) {
    return { message: 'This order has no items for Katana, so nothing was sent.' };
  }

  try {
    const { salesOrder, created } = await sendOrder(
      {
        swell: req.swell,
        appId: req.appId,
        storeId: req.store?.id || '',
        settings,
        appValues: (values) => req.appValues(values),
      },
      order,
    );
    return {
      message: created
        ? `Created Katana sales order ${salesOrder.order_no}.`
        : `Linked existing Katana sales order ${salesOrder.order_no}.`,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    await req.swell.put(`/orders/${orderId}`, req.appValues({ katana_error: message }));
    return { message: `Not sent: ${message}` };
  }
}
