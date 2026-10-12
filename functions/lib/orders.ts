import {
  KatanaError,
  KatanaFulfillment,
  KatanaSalesOrder,
  KatanaSettings,
  OPEN_STATUSES,
  addShippingFee,
  createCustomer,
  createSalesOrder,
  deleteSalesOrder,
  findCustomerByEmail,
  findSalesOrderByEcommerceId,
  findVariantsBySku,
  getAppData,
  getSalesOrder,
  listFulfillments,
} from './katana';
import { buildCustomer, buildSalesOrder, buildShippingFee, itemSku, shippableItems } from './mapping';

export interface SyncContext {
  swell: SwellAPI;
  appId: string;
  storeId: string;
  settings: KatanaSettings;
  appValues: (values: SwellData) => SwellData;
}

export async function getOrder(swell: SwellAPI, orderId: string): Promise<any> {
  return swell.get(`/orders/${orderId}`, {
    expand: ['account', 'items.product', 'items.variant'],
  });
}

// Katana customer for the order: saved on the account, found by email, or created
export async function resolveCustomerId(ctx: SyncContext, order: any): Promise<number> {
  const account = order.account;
  const saved = getAppData(account, ctx.appId).katana_customer_id;
  if (saved) {
    return saved;
  }

  const email = account?.email || order.account_email;
  const existing = email ? await findCustomerByEmail(ctx.settings, email) : null;
  const customer = existing || (await createCustomer(ctx.settings, buildCustomer(order)));

  if (account?.id) {
    await ctx.swell.put(`/accounts/${account.id}`, ctx.appValues({ katana_customer_id: customer.id }));
  }
  return customer.id;
}

function salesOrderValues(salesOrder: KatanaSalesOrder, customerId?: number) {
  return {
    katana_sales_order_id: salesOrder.id,
    katana_order_no: salesOrder.order_no,
    katana_status: salesOrder.status,
    ...(customerId && { katana_customer_id: customerId }),
    katana_synced_at: new Date().toISOString(),
    katana_error: null,
  };
}

// creates the Katana sales order for a Swell order; reuses one already created for it
export async function sendOrder(
  ctx: SyncContext,
  order: any,
): Promise<{ salesOrder: KatanaSalesOrder; created: boolean }> {
  const { swell, settings } = ctx;

  const existing = await findSalesOrderByEcommerceId(settings, String(order.id));
  if (existing) {
    await swell.put(`/orders/${order.id}`, ctx.appValues(salesOrderValues(existing, existing.customer_id)));
    return { salesOrder: existing, created: false };
  }

  const items = shippableItems(order);
  const variantsBySku = await findVariantsBySku(
    settings,
    items.map((item) => itemSku(item)).filter(Boolean) as string[],
  );

  // throws MissingSkuError before anything is created in Katana
  buildSalesOrder(order, { settings, customerId: 0, variantsBySku, storeId: ctx.storeId });

  const customerId = await resolveCustomerId(ctx, order);
  const salesOrder = await createSalesOrder(
    settings,
    buildSalesOrder(order, { settings, customerId, variantsBySku, storeId: ctx.storeId }),
  );

  const values: Record<string, unknown> = salesOrderValues(salesOrder, customerId);

  const fee = buildShippingFee(order, salesOrder.id, settings);
  if (fee) {
    try {
      await addShippingFee(settings, fee);
    } catch (err: any) {
      // the sales order exists; keep it and show why the fee is missing
      values.katana_error = `Shipping fee not added: ${err?.message || err}`;
    }
  }

  await swell.put(`/orders/${order.id}`, ctx.appValues(values));
  return { salesOrder, created: true };
}

// deletes the Katana sales order of a canceled Swell order while it hasn't shipped
export async function cancelOrder(ctx: SyncContext, order: any): Promise<'deleted' | 'shipped' | 'none'> {
  const { swell, settings } = ctx;
  const salesOrderId = getAppData(order, ctx.appId).katana_sales_order_id;
  if (!salesOrderId) {
    return 'none';
  }

  let salesOrder: KatanaSalesOrder | null = null;
  try {
    salesOrder = await getSalesOrder(settings, salesOrderId);
  } catch (err) {
    if (!(err instanceof KatanaError && err.status === 404)) {
      throw err;
    }
  }

  if (salesOrder && !OPEN_STATUSES.includes(salesOrder.status)) {
    await swell.put(
      `/orders/${order.id}`,
      ctx.appValues({
        katana_status: salesOrder.status,
        katana_error: `Order canceled in Swell, but the Katana sales order is ${salesOrder.status} and was not deleted`,
      }),
    );
    return 'shipped';
  }

  if (salesOrder) {
    try {
      await deleteSalesOrder(settings, salesOrderId);
    } catch (err) {
      if (!(err instanceof KatanaError && [404, 410].includes(err.status))) {
        throw err;
      }
    }
  }

  await swell.put(
    `/orders/${order.id}`,
    ctx.appValues({ katana_status: 'DELETED', katana_synced_at: new Date().toISOString(), katana_error: null }),
  );
  return 'deleted';
}

// Swell order for a Katana sales order: linked by id, or by the Swell order id stored on the sales order
export async function findSwellOrder(ctx: SyncContext, salesOrder: KatanaSalesOrder): Promise<any | null> {
  const found = await ctx.swell.get('/orders', {
    where: { [`$app.${ctx.appId}.katana_sales_order_id`]: salesOrder.id },
    limit: 1,
  });
  if (found?.results?.[0]) {
    return found.results[0];
  }
  const ecommerceOrderId = salesOrder.ecommerce_order_id;
  if (ecommerceOrderId && /^[0-9a-f]{24}$/i.test(ecommerceOrderId)) {
    return ctx.swell.get(`/orders/${ecommerceOrderId}`);
  }
  return null;
}

// copies a Katana sales order's status and tracking to its Swell order, and fulfills it when delivered
export async function applySalesOrder(
  ctx: SyncContext,
  salesOrder: KatanaSalesOrder,
): Promise<'updated' | 'unchanged' | 'not_found'> {
  const { swell, settings } = ctx;
  const order = await findSwellOrder(ctx, salesOrder);
  if (!order) {
    return 'not_found';
  }

  const appData = getAppData(order, ctx.appId);
  const status = salesOrder.deleted_at ? 'DELETED' : salesOrder.status;
  const wantsShipment =
    status === 'DELIVERED' && settings.create_fulfillment !== false && !appData.katana_shipment_id;

  const fulfillments = status === 'DELIVERED' ? await listFulfillments(settings, salesOrder.id) : [];
  const tracked = fulfillments.find((f) => f.tracking_number) || fulfillments[0];

  const values: Record<string, unknown> = {
    katana_sales_order_id: salesOrder.id,
    katana_order_no: salesOrder.order_no,
    katana_status: status,
    katana_tracking_number: tracked?.tracking_number || salesOrder.tracking_number || null,
    katana_tracking_url: tracked?.tracking_url || salesOrder.tracking_number_url || null,
  };

  const unchanged =
    !wantsShipment &&
    Object.entries(values).every(([key, value]) => (appData[key] ?? null) === value);
  if (unchanged) {
    return 'unchanged';
  }

  if (wantsShipment) {
    const shipmentId = await createSwellShipment(swell, order.id, salesOrder, tracked);
    if (shipmentId) {
      values.katana_shipment_id = shipmentId;
    }
  }

  values.katana_synced_at = new Date().toISOString();
  await swell.put(`/orders/${order.id}`, ctx.appValues(values));
  return 'updated';
}

export async function createSwellShipment(
  swell: SwellAPI,
  orderId: string,
  salesOrder: KatanaSalesOrder,
  fulfillment?: KatanaFulfillment,
): Promise<string | null> {
  const order = await swell.get(`/orders/${orderId}`);
  const items = (order?.items || [])
    .filter((item: any) => item.delivery === 'shipment' && item.quantity_shipment_deliverable > 0)
    .map((item: any) => ({
      order_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity_shipment_deliverable,
    }));

  if (!items.length) {
    console.log(`Katana: order ${order?.number} has nothing left to ship`);
    return null;
  }

  const shipping = order.shipping || {};
  const trackingNumber = fulfillment?.tracking_number || salesOrder.tracking_number || undefined;
  const trackingUrl = fulfillment?.tracking_url || salesOrder.tracking_number_url || undefined;

  const shipment = await swell.post('/shipments', {
    order_id: order.id,
    items,
    destination: {
      name: shipping.name,
      first_name: shipping.first_name,
      last_name: shipping.last_name,
      address1: shipping.address1,
      address2: shipping.address2,
      city: shipping.city,
      state: shipping.state,
      zip: shipping.zip,
      country: shipping.country,
      phone: shipping.phone,
    },
    carrier: fulfillment?.tracking_carrier || undefined,
    carrier_name: fulfillment?.tracking_carrier || undefined,
    service: fulfillment?.tracking_method || undefined,
    service_name: fulfillment?.tracking_method || undefined,
    tracking_code: trackingNumber,
    notes: `Katana sales order ${salesOrder.order_no}${trackingUrl ? `: ${trackingUrl}` : ''}`,
  });

  console.log(`Katana: created shipment ${shipment.id} for order ${order.number}`);
  return shipment.id;
}
