# Katana for Swell

Connects Swell to [Katana Cloud Inventory](https://katanamrp.com). Paid Swell orders become Katana **sales orders**. Every 5 minutes the app checks Katana for changes and brings status, tracking and stock back: when a sales order is delivered in Katana, the Swell order is fulfilled, and Swell stock levels follow Katana inventory. No webhook or Swell API key is needed.

## Features

- **Orders to Katana:** when an order is paid (or submitted, see settings) and has items to ship, the app creates a Katana sales order through `POST /v1/sales_orders`. It includes:
  - the customer
  - billing and shipping addresses
  - one row per item, matched to a Katana variant **by SKU**, with quantity, unit price, item discount and an optional tax rate. Items sent: physical items (delivered by shipment), and digital items whose product has **stock tracking** on. Gift cards, subscriptions and digital items without stock tracking are left out; an order with none of the sent items is skipped.
  - the currency, order date and order comments
  - the shipping price as a Katana shipping fee
  
  The sales order number is the prefix plus the Swell order number (e.g. `SW-1001`). The Swell order ID is stored on the sales order as `ecommerce_order_id`, so an order is never created twice.
- **Customers:** the Katana customer is found by email or created, with the order's addresses. Its ID is saved on the Swell account, so the lookup happens only once per customer.
- **Missing or duplicate SKUs:** if any item sent to Katana has no SKU, a SKU that isn't in Katana, or a SKU that more than one Swell product or variant uses, nothing is created and the order isn't retried. The order shows which SKUs are missing or duplicated. Fix them, then use **Send to Katana** on the order.
- **Canceled orders:** when a Swell order is canceled, its Katana sales order is deleted if it hasn't been packed or delivered yet. If it has, it's kept and the order shows why. This can be turned off.
- **Status and tracking from Katana:** every 5 minutes the app reads the sales orders it created that changed in Katana since the last check, and updates each Swell order's Katana status (`NOT_SHIPPED`, `PACKED`, `DELIVERED`, `DELETED`) and tracking number and URL.
- **Fulfillment:** when the sales order is **delivered** in Katana, the app creates a Swell shipment for the physical items still to be shipped. The shipment gets the tracking number, carrier and method from the Katana fulfillment. Digital items are never put in a shipment; an order with only digital items gets the `DELIVERED` status but no shipment.
- **Stock from Katana:** Katana is the source of truth for stock. Every 5 minutes the app reads Katana's stock movements at the location since the last check, and sets the current level on the Swell product or variant with the same SKU. An hourly **stock sync job** also reconciles all inventory, which catches changes that don't create a stock movement (such as committed quantities). The level is either *in stock minus committed* or *in stock*, for one Katana location, and can be negative: negative stock in Katana (or more committed than in stock) becomes the same negative level in Swell, which Swell shows as out of stock. Swell stock is changed through normal stock adjustments, so the history shows "Katana stock sync".
- **Katana tasks** (dashboard sidebar): long syncs run as jobs, one page per step, with live progress (checked, updated, skipped, SKUs not in Swell, failed), **Cancel** and **Resume**. If Katana is rate-limiting or down, a job waits and retries on its own (up to 8 times, backing off from 1 minute to 30 minutes). Three kinds:
  - **Stock from Katana:** all Katana inventory at the location, applied to Swell stock. Started every hour, or with **Sync stock from Katana** (app settings Actions menu, or the Katana tasks list). The job page has a **Stock changes** table listing only the Swell products and variants whose stock changed: product, variant, change (e.g. `-1`) and SKU. The dashboard shows the first three as columns; **View** on a row shows all four.
  - **Existing orders to Katana:** paid orders (all orders when sending on submit) that aren't in Katana yet and aren't delivered, optionally from a date. Each sales order commits stock in Katana until it's delivered there, so use a start date to leave out old orders. Started with **Send orders to Katana**. Orders Katana rejects get the error on their Katana tab and the job carries on.
  - **Swell products to Katana:** started with **Create products in Katana** (app settings Actions menu, or the Katana tasks list). For every Swell product with stock tracking on, creates the Katana product with its variants, matched by SKU. Swell variant options become Katana variant configs (e.g. `Color: red`), with the Swell price as sales price and cost as purchase price. SKUs already in Katana aren't created again; if a product is partly in Katana, only the missing variants are added to it. Then each variant with non-zero Swell stock that has **no positive stock in Katana** at the location (0 or negative) gets a stock adjustment ("Starting stock from Swell") for the difference, so Katana's stock equals the Swell stock (plus anything committed, when stock follows *in stock minus committed*). This works both ways with negative stock: Katana at −3 and Swell at 10 adjusts by +13; Swell at −5 and Katana at 0 adjusts by −5. The Swell cost is sent only on adjustments that add stock. Items without a SKU are skipped. A product with a SKU that another Swell product or variant also uses isn't created and counts as failed. Products Katana rejects, or with a duplicate SKU, show the error on their Katana tab. Running it again is safe.
- **Katana pulls** (dashboard sidebar): a log of the 5-minute checks that changed something in Swell, per source (sales orders or stock), with counts and errors. A check that runs out of time continues on the next run from where it stopped. Checks that change nothing aren't logged. Stock checks have the same **Stock changes** table as stock sync jobs.
- **Order tab:** a **Katana** tab on the order page shows the sales order number and ID, status, Katana customer ID, tracking number and URL, last sync time and the last error. The orders list gets a **Katana** status column.
- **Product tab:** a **Katana** tab on the product page shows when Katana last changed the stock, and any error.
- **Actions in the app settings:**
  - **Test connection** checks the API key and lists your Katana locations and tax rates with their IDs.
  - **Get updates from Katana** runs the 5-minute check right away.
  - **Sync stock from Katana** starts a stock sync job (same as the button of that name under Katana tasks).
  - **Create products in Katana** starts a product export job (see Katana tasks above).
- **Action on the order:** **Send to Katana** (in the order's Actions menu) creates the sales order now, e.g. after fixing a SKU or the settings.

## Settings

All credentials and options are app settings (`settings/katana.json`). Nothing is hard-coded.

| Setting | Required | Default | Description |
|---|---|---|---|
| API key | yes | | Katana API key (Katana → Settings → API → API keys). A secret field: masked in the dashboard, with show and copy buttons. |
| Location ID | yes | | Katana location that ships Swell orders. Its stock is copied to Swell. **Test connection** lists the IDs. |
| Tax rate ID | no | | Katana tax rate set on every sales order row and on the shipping fee. If empty, Katana uses its default. |
| Send orders to Katana when | no | Order is paid | `Order is paid` (`order.paid`) or `Order is submitted` (`order.submitted`). |
| Sales order number prefix | no | `SW-` | Katana sales order number = prefix + Swell order number. Can be empty. |
| When a Swell order is canceled | no | Delete | `Delete the Katana sales order (if not shipped yet)` or `Do nothing`. |
| Create Swell shipment when delivered in Katana | no | on | Fulfills the Swell order with the Katana tracking number. |
| Sync stock from Katana automatically | no | on | Sets Swell stock from Katana (moved items every 5 minutes + an hourly stock sync job). Only products with stock tracking on are changed. |
| Stock quantity to use | no | In stock minus committed | `In stock minus committed` (what's still free to sell) or `In stock`. |
| Sync job page size | no | 50 | Katana inventory rows, Swell orders or Swell products read per step of a sync job (1–250; product exports use at most 100). Each step also stops after about 7 seconds. |
| Sales orders last checked | read-only | | Start of the last completed 5-minute check of sales orders. The next one reads changes from a minute before. |
| Stock last checked | read-only | | Start of the last completed 5-minute check of stock movements. The next one reads changes from a minute before. |
| Enabled | no | on | Turns off sending orders, cancellations, the 5-minute check, sync jobs and the app actions (except Test connection) without uninstalling the app. |

The API key and Location ID aren't marked required in the form, because you need a saved key before **Test connection** can show the location IDs. Nothing syncs until both are set.

## Getting started

### 1. Get a Katana API key

1. You need a Katana plan with API access (Professional or higher).
2. In Katana, go to **Settings → API → API keys** and click **+ Add new API key**.
3. Copy the key from the pop-up and give it a name such as "Swell". Katana shows the key only once.

### 2. Install the app and connect Katana

1. Install the app in your Swell store. While developing, `swell app push` installs it in the test environment (see [Development](#development)).
2. In the Swell dashboard, open **Apps → Katana** (the app's settings). Paste the **API key** and click **Save**.
3. Open the **Actions** menu and run **Test connection**. It lists your Katana locations and tax rates, e.g. `Locations: 101 = Main warehouse`.
4. Enter the **Location ID** of the warehouse that ships Swell orders. Optionally enter a **Tax rate ID**. Click **Save**, then run **Test connection** again to check them.

### 3. Match products and sync stock

1. Make sure each physical Swell product, and each digital product with stock tracking, has the **same SKU as its Katana variant**. For products with options, that's the SKU on each Swell variant. If the products aren't in Katana yet, turn on stock tracking for them in Swell and run **Actions → Create products in Katana**: it creates them in Katana with their variants and copies the Swell stock as Katana's starting stock. Check the job under **Katana tasks** before going on.
2. Turn on **Stock tracking** for the Swell products whose stock should follow Katana. Products with stock tracking off are left alone.
3. Run **Actions → Sync stock from Katana**, then open **Katana tasks** in the dashboard sidebar. The job shows how many Katana items were checked, how many Swell stock levels changed, how many were skipped (stock tracking off), how many SKUs weren't found in Swell, and which SKUs are on more than one Swell product or variant (**SKUs on several Swell items**; their stock isn't synced).
4. Optional: to send orders placed before the app was installed, use **Katana tasks → Send orders to Katana**, with a start date to leave out old orders (each sales order commits stock in Katana until it's delivered there).

### 4. Try it

1. Place and pay for a test order. Its **Katana** tab should show a sales order number such as `SW-1001`, status `NOT_SHIPPED`, and no error. The sales order should appear in Katana under **Sell**.
2. Mark the sales order **Delivered** in Katana, with a tracking number on the fulfillment. Within 5 minutes (or right away with **Actions → Get updates from Katana** in the app settings), the Swell order should show status `DELIVERED`, the tracking number, and a new shipment.
3. Change a product's stock in Katana (e.g. a stock adjustment). Within 5 minutes, or after **Get updates from Katana**, the Swell stock for that SKU should follow. **Katana pulls** shows a record for each check that changed something.

If the Katana tab shows an error, fix the cause (usually a missing SKU) and use **Send to Katana** on the order.

## How it works

| Function | Trigger | What it does |
|---|---|---|
| `functions/order-events.ts` | `order.submitted`, `order.paid`, `order.canceled` | Creates the sales order on the event chosen in settings. Deletes it on cancel. |
| `functions/katana-poll.ts` | Cron, every 5 minutes (`*/5 * * * *`) | Checks sales orders and stock movements that changed in Katana and applies them to Swell; logs checks in `apps/katana/pulls`. |
| `functions/inventory-sync.ts` | Cron, hourly at :02 (`2 * * * *`) | Starts a stock sync job unless one is active, and removes scheduled jobs completed more than 3 days ago. |
| `functions/sync-run.ts` | `sync.created`, `sync.updated` (status pending/running) | Runs one step of a sync job. Saving the step's progress triggers the next step. |
| `functions/sync-retry.ts` | Model schedule on `date_retry` | Sets a waiting job back to pending at its retry time. |
| `functions/sync-control.ts` | Job actions | Cancel and Resume on a sync job. |
| `functions/katana-actions.ts` | App actions | Test connection, Get updates from Katana, Sync stock from Katana, Create products in Katana (settings); Sync stock from Katana, Send orders to Katana, Create products in Katana (Katana tasks list); Send to Katana (order). |
| `functions/lib/katana.ts` | Shared | Katana API client (auth, errors, 429 handling, pagination params), resources, and the "changed since" queries used by polling. |
| `functions/lib/mapping.ts` | Shared | Maps a Swell order to a Katana sales order, customer and addresses; finds missing SKUs; computes stock quantities. |
| `functions/lib/orders.ts` | Shared | Sends and cancels orders (finds or creates the customer, creates the sales order and shipping fee); applies Katana status and tracking to Swell orders and creates the shipment. |
| `functions/lib/pull.ts` | Shared | The 5-minute check: per source, works out the time window, pages through changes, resumes running checks, logs and saves the checkpoint. |
| `functions/lib/jobs.ts` | Shared | Sync jobs: starting one per type, the stock, order and product steps, retry timing. |
| `functions/lib/products.ts` | Shared | Product export: Swell products and variants to Katana products and variant configs, and starting stock adjustments. |
| `functions/lib/stock.ts` | Shared | Matches Katana SKUs to Swell products and variants, and posts stock adjustments. |

**Data stored by the app** (under `$app.katana` on standard records):

- orders (`models/orders.json`): `katana_sales_order_id`, `katana_order_no`, `katana_customer_id`, `katana_status`, `katana_tracking_number`, `katana_tracking_url`, `katana_shipment_id`, `katana_synced_at`, `katana_error`
- accounts (`models/accounts.json`): `katana_customer_id`
- products (`models/products.json`): `katana_stock_synced_at`, `katana_error`

**App collections:**

- `apps/katana/syncs` (`models/syncs.json`, **Katana tasks**): one record per job. `type` (`inventory`, `orders`, `products`), `trigger` (`manual`, `schedule`), `status` (`pending`, `running`, `waiting`, `completed`, `failed`, `canceled`), cursor (`page` for stock, `last_id` for orders and products), counts (`adjusted` = starting stock set), `duplicate_skus` (stock syncs: Katana SKUs on more than one Swell product or variant, not synced, up to 100), `report` (stock syncs: the Swell stock changes, rows of `product`, `variant`, `change`, `sku`, appended each step with `$push`, up to 2,000 rows) and `report_rows` (all changes, including any beyond 2,000), `last_error`, `retries`, `date_retry`, dates.
- `apps/katana/pulls` (`models/pulls.json`, **Katana pulls**): one record per check that changed something or continues next run. `source` (`sales_orders`, `inventory`), `status` (`running`, `completed`), `changed`, `not_found`, `failed`, `duplicate_skus` and `report` and `report_rows` (stock checks: same as on syncs), `date_cursor`, `date_pass_started`, `page`, `last_error`.

**5-minute checks:**
1. Each run checks two sources, sales orders and stock, taking turns which goes first. Each source reads changes since its previous completed check, minus 1 minute so nothing saved during a check is missed. The first check looks back 1 hour.
2. It reads `GET /v1/sales_orders?ecommerce_order_type=swell&updated_at_min=…&include_deleted=true` and finds each Swell order by `$app.katana.katana_sales_order_id`, falling back to the sales order's `ecommerce_order_id`. Delivered orders also read `GET /v1/sales_order_fulfillments` for the carrier and tracking.
3. It reads `GET /v1/inventory_movements?location_id=…&created_at_min=…`, then `GET /v1/inventory` for the variants that moved, and sets their Swell stock.
4. Only when a source is fully processed does it save its checkpoint (**Sales orders last checked** / **Stock last checked**). Checkpoints are written with `$events: false`, so they don't add a `setting.updated` event every 5 minutes. If time runs out or Katana fails, the check is saved as `running` in **Katana pulls** with its window and page, and the next run continues there. All updates are idempotent, and unchanged orders aren't written.

**Sync jobs:** creating a `syncs` record fires `sync.created`, and `sync-run` runs the first step: one page (stock: `GET /v1/inventory?page=…`; orders and products: Swell records after `last_id`), within about 7 seconds. It saves the counts and the cursor, and that update fires the next step until a short page completes the job. A Katana 429 or 5xx puts the job in `waiting` with `date_retry`; `sync-retry` sets it back to `pending` at that time. Other errors fail the job; **Resume** continues where it stopped. Only one job per type can be active.

**Stock:** Swell stock is a ledger of adjustments. The app compares the Swell level with the Katana quantity, rounded down to whole units (negative levels included, e.g. −2.5 → −3), and posts one `products:stock` adjustment for the difference. A product's own SKU is used only when it has no variants; otherwise variant SKUs are used. A SKU found on more than one Swell product without variants or variant isn't matched at all (see Limits).

**Permissions:** `permissions` in `swell.json` is empty (full access). The app needs `read_settings` for its own settings, and scoped permissions would block that (see the Swell app docs). It reads and writes orders, accounts, products, stock and shipments.

## Limits

- **A SKU must be on one Swell product or variant.** Swell keeps product SKUs unique but allows the same SKU on several variants (of one product or of different products), or on a variant and a product without variants. The app treats such a SKU as a conflict, because one Katana variant can't feed several Swell stock levels:
  - stock syncs and 5-minute checks leave those Swell products and variants unchanged and list the SKU under **SKUs on several Swell items** on the sync or check;
  - orders with such an item aren't sent and show `Same SKU on more than one Swell product or variant: …` on their Katana tab (no retry);
  - **Create products in Katana** doesn't create those products and shows the same error on them.

  Give each Swell variant its own SKU (matching a Katana variant), then run **Sync stock from Katana** and **Send to Katana** for the affected orders. The check looks at the whole Swell catalog for each SKU, so it also finds a duplicate on a product with stock tracking off.
- **Matching is by SKU only.** Items without a SKU, or with a SKU that isn't in Katana, stop the whole order from being sent. Only physical items and digital items with stock tracking are sent; gift cards, subscriptions and untracked digital items are skipped.
- **Products go to Katana once, on demand.** **Create products in Katana** creates missing products and variants and sets starting stock. It never updates names, prices or options of products already in Katana, and Katana products are never created in Swell. Otherwise only stock levels move (Katana → Swell).
- **Product export details.** Katana allows up to 10 variant options with 40 values each; Katana rejects products beyond that, or two variants with the same option values, and they show as failed. Starting stock is set only where Katana has 0 or negative stock at the location, so positive stock already counted in Katana is never overwritten, even when Swell is negative. Products with 0 stock in Swell get no starting stock: if Katana is negative for them, the next stock sync brings that negative level to Swell. Each product takes 3–4 Katana requests, so large catalogs take several minutes (the job waits out rate limits). Between creating a product and setting its stock (a second or two), an hourly stock sync could set the Swell stock to 0; if that happens, set the stock again in Swell and rerun the export.
- **One location.** Sales orders ship from one Katana location, and only that location's stock is copied to Swell.
- **Order edits aren't synced.** Changes to a Swell order after it was sent (items, address) don't update the Katana sales order.
- **Prices are sent as Swell has them.** If your Swell prices include tax, set up Katana's tax rate to match, or the totals will differ. Order-level discounts count only where Swell spreads them onto the items' `discount_total`.
- **Digital items with stock tracking go to Katana like physical ones.** Their stock is reserved in Katana when the sales order is created and deducted only when it's marked **Delivered**, so someone has to deliver these sales orders in Katana even though nothing ships, including orders with only digital items. With the default **Stock quantity to use** (`In stock minus committed`) Swell stock stays right in the meantime; with `In stock`, stock syncs from Katana can put Swell stock back up until the sales order is delivered.
- **Shipments only on delivery.** The Swell shipment is created when the whole sales order is `DELIVERED`, for everything still unshipped. Partial deliveries in Katana aren't mirrored.
- **Up to 5 minutes delay.** Changes in Katana reach Swell on the next check, not instantly. Use **Get updates from Katana** when testing.
- **Why not webhooks:** Katana rejects webhook URLs that contain credentials (it answers `500`), and Swell function routes can only be reached with a public key in the request. So Katana webhooks can't call the app directly. Polling avoids that and needs no key.
- **Canceling doesn't undo shipped orders.** Packed or delivered sales orders are kept when the Swell order is canceled.
- **Rate limit.** Katana allows 60 requests per minute. Sending one order takes 4–6 requests. Each 5-minute check takes 2, plus 1 per delivered order and 1 per 50 moved items. A stock sync step takes 1. If Katana asks the app to wait up to 3 seconds, it waits once; otherwise the request fails and is retried later (sync jobs wait 1 minute).
- **Run time.** Each check and each job step has about 7 seconds (functions stop at 10 s). Jobs take as many steps as they need. A check with more changes than fit continues on the next run.
- **Negative stock.** Katana allows negative stock (for example, delivering a sales order without enough stock) but doesn't recommend it, because its average costs and margins become wrong. The app mirrors negative levels both ways and doesn't prevent them; Swell blocks purchases at a negative level unless the product allows backorders.
- **Overlapping stock writes.** A 5-minute check and a stock sync job that change the same SKU at the same moment could each post the difference. The hourly job starts at :02 to stay clear of the check; the next sync corrects any drift.
- **Order sync scope.** **Send orders to Katana** skips canceled and delivered orders, orders already linked to a sales order, and orders with no items for Katana. **Send to Katana** on a single order refuses canceled orders. It doesn't re-send orders that failed earlier in the same job; fix them and use **Send to Katana** on the order.
- **Retries.** Errors are saved on the order's `katana_error`. Only Katana 429 and 5xx errors are retried: order events by the platform, sync jobs by `sync-retry`. Model-event functions that keep failing are turned off by the platform after about 4 days. `swell app push --force` turns them back on.

## Development

Needs the [Swell CLI](https://developers.swell.is/cli) (`swell login`) and Node 20+.

```bash
npm install
swell app push         # deploy to the store's test environment (use --force after changing only functions/lib)
swell app dev          # run model events locally against the test environment
npm test               # vitest: unit tests + read-only integration tests
npm run typecheck
swell inspect functions --app=.
swell inspect settings app.katana
swell logs --type function -s order-events
```

- **Unit tests** (`test/unit/`) mock Swell (`req.swell`) and Katana (`fetch`, see `katanaFetch` in `test/helpers/fixtures.ts`). Every exported function and every top-level function has tests.
- **Integration tests** (`test/integration/`) are read-only and use your `swell login` session against the test store. They check the deployed settings and the queries the app relies on. Run them after `swell app push`.
- **Running a check by hand:** use **Actions → Get updates from Katana** in the app settings, or wait for the cron and read `swell logs --type function -s katana-poll` and the **Katana pulls** list.
- **Starting a job by hand:** `swell api post /apps/katana/syncs --body '{"type":"inventory"}'` (or `"orders"` with an optional `date_from`), then `swell api get /apps/katana/syncs/<id>`. In Git Bash set `MSYS_NO_PATHCONV=1` first.
- **Actions** can only be run by a dashboard user. `swell api` can't call them.
- **Settings writes:** the app saves the last check times with `PUT /settings/katana`. That request is validated against the settings schema, which is one reason no setting is marked required.
- **Test scaffold:** `@cloudflare/vitest-pool-workers` is pinned to `~0.12.21`, the last version that works with vitest 3.2. `test/helpers/mock-request.ts` was adjusted so it type-checks (the scaffold spreads `URLSearchParams`, which the workers lib doesn't type as iterable).
- **Assets:**
  - `assets/icon.png` is Katana's official app icon ("kt" on lime), 512×512 PNG. It's Katana's trademark, used to identify the integration.
  - `assets/screenshots/` holds the four listing images referenced from `images` in `swell.json`, 3200×1800 PNG each, in the same style as the other Swell integration listings (headline, recreated dashboard, numbered callouts):

    | File | Title | Shows |
    |---|---|---|
    | `1-settings.png` | Connected in a few minutes | App settings with the API key (secret field) and Location ID |
    | `2-katana-tasks.png` | Big syncs, step by step | **Katana tasks** list with the three start buttons and task progress |
    | `3-katana-pulls.png` | Updates from Katana every 5 minutes | **Katana pulls** list with the stock and sales order checks |
    | `4-stock-from-katana.png` | Stock that follows Katana | A product's stock history with a "Katana stock sync (location …)" adjustment |


