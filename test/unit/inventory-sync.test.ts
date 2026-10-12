import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { KEEP_SCHEDULED_MS, removeOldScheduledJobs } from "../../functions/inventory-sync";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS } from "../helpers/fixtures";

function setup({ settings = SETTINGS as Record<string, any>, active = [] as any[], old = [] as any[] } = {}) {
  const get = vi.fn(async (_url: string, query: any) => ({ results: query?.where?.trigger ? old : active }));
  const post = vi.fn(async (_url: string, body: any) => ({ id: "new", ...body }));
  const del = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    appId: "katana",
    swell: { settings: vi.fn().mockResolvedValue({ katana: settings }), get, post, delete: del },
  });
  return { req, get, post, del };
}

describe("inventory-sync", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts a scheduled stock sync job", async () => {
    const { req, post } = setup();
    await handler(req);
    expect(post).toHaveBeenCalledWith("/syncs", { type: "inventory", status: "pending", trigger: "schedule" });
  });

  it("doesn't start another while one is active", async () => {
    const { req, post } = setup({ active: [{ id: "busy", status: "running" }] });
    await handler(req);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["the app is disabled", { enabled: false }],
    ["inventory sync is off", { sync_inventory: false }],
    ["credentials are missing", { api_key: "" }],
  ])("does nothing when %s", async (_name, override) => {
    const { req, get, post } = setup({ settings: { ...SETTINGS, ...override } });
    await handler(req);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("removeOldScheduledJobs", () => {
  it("deletes completed scheduled jobs older than a few days", async () => {
    const { req, get, del } = setup({ old: [{ id: "a" }, { id: "b" }] });
    const now = Date.parse("2026-10-07T12:00:00.000Z");

    expect(await removeOldScheduledJobs(req.swell, now)).toBe(2);

    expect(get).toHaveBeenCalledWith("/syncs", {
      where: { trigger: "schedule", status: "completed", date_created: { $lt: new Date(now - KEEP_SCHEDULED_MS).toISOString() } },
      fields: "id",
      limit: 25,
    });
    expect(del.mock.calls).toEqual([["/syncs/a"], ["/syncs/b"]]);
  });
});
