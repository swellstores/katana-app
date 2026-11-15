import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemsAlreadyShipped, ShipmentPending, createSwellShipment, itemsShippedNote } from "../../functions/lib/shipments";
import { ORDER_ID, makeOrder } from "../helpers/fixtures";

const SALES_ORDER = { id: 900, order_no: "SW-100506", tracking_number: "1Z999" } as any;
const OWN = { id: "ship_own", notes: "Katana sales order SW-100506: https://track/1Z999", date_created: "2026-11-15T10:00:00Z" };
const CANNOT_SHIP = { items: { message: "Cannot ship 2 of item item_1, only 0 left to deliver", code: "INVALID" } };

function refusal(body: unknown, status = 400) {
  return Object.assign(new Error("POST /shipments\nrefused"), { name: "SwellError", status, body });
}

// swell mock: `shipments` answers each GET /shipments in turn, `left` is the deliverable quantity of the order reread after a refusal
function client({ shipments = [[], []] as any[][], left = 2, post = vi.fn().mockResolvedValue({ id: "ship_new" }) } = {}) {
  const lookups = [...shipments];
  let orderReads = 0;
  return {
    get: vi.fn(async (url: string) => {
      if (url === "/shipments") return { results: lookups.shift() || [] };
      if (url === `/orders/${ORDER_ID}`) {
        const order = makeOrder();
        if (orderReads++ > 0) order.items[0].quantity_shipment_deliverable = left;
        return order;
      }
      return null;
    }),
    post,
    put: vi.fn().mockResolvedValue({}),
  } as any;
}

describe("createSwellShipment", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates the shipment with $validate_items for the items left to ship", async () => {
    const swell = client();
    await expect(createSwellShipment(swell, ORDER_ID, SALES_ORDER)).resolves.toBe("ship_new");
    expect(swell.post).toHaveBeenCalledWith(
      "/shipments",
      expect.objectContaining({ $validate_items: true, tracking_code: "1Z999", notes: "Katana sales order SW-100506" }),
    );
  });

  it("reuses the shipment it created for the sales order, even without tracking", async () => {
    const other = { id: "ship_other", notes: "Katana sales order SW-100506X" };
    const swell = client({ shipments: [[other, { ...OWN, notes: "Katana sales order SW-100506" }]] });
    await expect(createSwellShipment(swell, ORDER_ID, { ...SALES_ORDER, tracking_number: null })).resolves.toBe("ship_own");
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("ignores shipments made by hand", async () => {
    const swell = client({ shipments: [[{ id: "ship_hand", notes: "Packed by Ann" }], []] });
    await expect(createSwellShipment(swell, ORDER_ID, SALES_ORDER)).resolves.toBe("ship_new");
  });

  it("reuses an overlapping check's shipment after a refusal", async () => {
    const swell = client({ shipments: [[], [OWN]], post: vi.fn().mockRejectedValue(refusal(CANNOT_SHIP)) });
    await expect(createSwellShipment(swell, ORDER_ID, SALES_ORDER)).resolves.toBe("ship_own");
  });

  it("retries when the refused items are still deliverable (a reservation)", async () => {
    const swell = client({ left: 2, post: vi.fn().mockRejectedValue(refusal({ errors: CANNOT_SHIP }, 422)) });
    await expect(createSwellShipment(swell, ORDER_ID, SALES_ORDER)).rejects.toBeInstanceOf(ShipmentPending);
  });

  it("reports nothing left to ship when fewer items are left, fully or partly", async () => {
    for (const left of [0, 1]) {
      const swell = client({ left, post: vi.fn().mockRejectedValue(refusal(CANNOT_SHIP)) });
      const error = await createSwellShipment(swell, ORDER_ID, SALES_ORDER).catch((e) => e);
      expect(error).toBeInstanceOf(ItemsAlreadyShipped);
      expect(error.message).toBe(CANNOT_SHIP.items.message);
    }
  });

  it("retries when the order's shipments are locked", async () => {
    const locked = { order_id: { message: "Order shipments are being updated, please try again" } };
    const swell = client({ post: vi.fn().mockRejectedValue(refusal(locked)) });
    await expect(createSwellShipment(swell, ORDER_ID, SALES_ORDER)).rejects.toBeInstanceOf(ShipmentPending);
  });

  it("rethrows other errors", async () => {
    const other = refusal({ destination: { message: "Invalid" } });
    await expect(createSwellShipment(client({ post: vi.fn().mockRejectedValue(other) }), ORDER_ID, SALES_ORDER)).rejects.toBe(other);

    const server = refusal({ error: "boom" }, 500);
    await expect(createSwellShipment(client({ post: vi.fn().mockRejectedValue(server) }), ORDER_ID, SALES_ORDER)).rejects.toBe(server);
  });

  it("cancels its copy when an overlapping check created one first", async () => {
    const swell = client({ shipments: [[], [OWN, { id: "ship_new", notes: "Katana sales order SW-100506: x", date_created: "2026-11-15T10:00:01Z" }]] });
    await expect(createSwellShipment(swell, ORDER_ID, SALES_ORDER)).resolves.toBe("ship_own");
    expect(swell.put).toHaveBeenCalledWith("/shipments/ship_new", { canceled: true });
  });

  it("explains the note", () => {
    expect(itemsShippedNote("nothing left to ship")).toContain("(nothing left to ship).");
  });
});
