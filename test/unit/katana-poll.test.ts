import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/katana-poll";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, katanaCalls, katanaFetch } from "../helpers/fixtures";

function setup(settings: Record<string, any> = SETTINGS) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    appId: "katana",
    swell: {
      settings: vi.fn().mockResolvedValue({ katana: settings }),
      get: vi.fn().mockResolvedValue({ results: [] }),
      put,
      post: vi.fn(),
    },
  });
  return { req, put };
}

describe("katana-poll", () => {
  let fetchMock: ReturnType<typeof katanaFetch>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock = katanaFetch({ "GET /sales_orders": { data: [] }, "GET /inventory_movements": { data: [] } });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);
  });

  afterEach(() => vi.restoreAllMocks());

  it("checks sales orders and stock and saves each checkpoint", async () => {
    const { req, put } = setup();
    await handler(req);
    expect(katanaCalls(fetchMock).sort()).toEqual(["GET /inventory_movements", "GET /sales_orders"]);
    expect(put).toHaveBeenCalledWith("/settings/katana", { katana: { orders_checked_at: expect.any(String) } });
    expect(put).toHaveBeenCalledWith("/settings/katana", { katana: { stock_checked_at: expect.any(String) } });
  });

  it("skips stock when inventory sync is off", async () => {
    const { req } = setup({ ...SETTINGS, sync_inventory: false });
    await handler(req);
    expect(katanaCalls(fetchMock)).toEqual(["GET /sales_orders"]);
  });

  it.each([
    ["the app is disabled", { enabled: false }],
    ["credentials are missing", { location_id: undefined }],
  ])("does nothing when %s", async (_name, override) => {
    const { req, put } = setup({ ...SETTINGS, ...override });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
