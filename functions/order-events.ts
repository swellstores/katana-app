import { getAppData, getKatanaSettings, hasCredentials, isRetryable } from './lib/katana';
import { MissingSkuError, katanaItems } from './lib/mapping';
import { cancelOrder, getOrder, sendOrder } from './lib/orders';

export const config: SwellConfig = {
  description: 'Send orders to Katana as sales orders and remove them when canceled',
  model: {
    events: ['order.submitted', 'order.paid', 'order.canceled'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data, appId, store } = req;
  const eventType = data.$event?.type;
  const orderId: string = data.id;

  const settings = await getKatanaSettings(swell);
  if (settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Katana: missing required settings (api_key, location_id)');
    return;
  }

  const order = await getOrder(swell, orderId);
  if (!order) {
    console.error(`Katana: order ${orderId} not found`);
    return;
  }

  const ctx = {
    swell,
    appId,
    storeId: store?.id || '',
    settings,
    appValues: (values: SwellData) => req.appValues(values),
  };

  if (eventType === 'order.canceled') {
    if (settings.on_cancel === 'none') {
      return;
    }
    try {
      const result = await cancelOrder(ctx, order);
      console.log(`Katana: order ${order.number} canceled, sales order ${result}`);
    } catch (err: any) {
      const message = err?.message || String(err);
      console.error(`Katana: failed to delete the sales order of canceled order ${order.number} - ${message}`);
      await swell.put(`/orders/${orderId}`, req.appValues({ katana_error: message }));
      if (isRetryable(err)) {
        throw new SwellError(message, { status: 502, retry: true });
      }
    }
    return;
  }

  const syncEvent = settings.sync_on === 'submitted' ? 'order.submitted' : 'order.paid';
  if (eventType !== syncEvent) {
    return;
  }

  const appData = getAppData(order, appId);
  if (appData.katana_sales_order_id) {
    console.log(`Katana: order ${order.number} already sent as sales order ${appData.katana_order_no}`);
    return;
  }

  if (!katanaItems(order).length) {
    console.log(`Katana: order ${order.number} has no items for Katana, skipping`);
    return;
  }

  try {
    const { salesOrder } = await sendOrder(ctx, order);
    console.log(`Katana: sent order ${order.number} as sales order ${salesOrder.order_no} (${salesOrder.id})`);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Katana: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${orderId}`, req.appValues({ katana_error: message }));

    // missing SKUs and 4xx mean the data or settings are wrong; retrying won't help
    if (err instanceof MissingSkuError || !isRetryable(err)) {
      return;
    }
    throw new SwellError(message, { status: 502, retry: true });
  }
}
