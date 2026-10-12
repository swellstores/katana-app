import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { save } from "../../functions/sync-run";
import { MAX_RETRIES } from "../../functions/lib/jobs";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, katanaFetch } from "../helpers/fixtures";

const JOB_ID = "6ac623e9bf440b0012d66600";

function setup({
  job = { id: JOB_ID, type: "inventory", status: "pending" } as Record<string, any> | null,
  current = undefined as Record<string, any> | null | undefined,
  others = [] as Record<string, any>[],
  settings = SETTINGS as Record<string, any>,
  event = { type: "sync.created" } as Record<string, any>,
} = {}) {
  let reads = 0;
  const get = vi.fn(async (url: string) => {
    if (url === `/syncs/${JOB_ID}`) {
      // the first read is the job, later reads are the current state before saving
      return reads++ === 0 || current === undefined ? job : current;
    }
    if (url === "/syncs") return { results: others };
    if (url === "/products" || url === "/products:variants") return { results: [] };
    return null;
  });
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { id: JOB_ID, $event: event } as any,
    appId: "katana",
    store: { id: "onixo" } as any,
    swell: { settings: vi.fn().mockResolvedValue({ katana: settings }), get, put, post: vi.fn() },
  });
  return { req, put, get };
}

describe("sync-run", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(katanaFetch({ "GET /inventory": { data: [] } }) as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs a step and completes the job", async () => {
    const { req, put } = setup();
    await handler(req);
    expect(put).toHaveBeenCalledWith(`/syncs/${JOB_ID}`, expect.objectContaining({
      status: "completed",
      pages: 1,
      page: 1,
      date_started: expect.any(String),
      date_completed: expect.any(String),
    }));
  });

  it("ignores updates that aren't a recorded step", async () => {
    const { req, get } = setup({ event: { type: "sync.updated", data: { last_error: null } } });
    await handler(req);
    expect(get).not.toHaveBeenCalled();
  });

  it("ignores jobs that are no longer active", async () => {
    const { req, put } = setup({ job: { id: JOB_ID, type: "inventory", status: "canceled" }, event: { type: "sync.updated", data: { pages: 2 } } });
    await handler(req);
    expect(put).not.toHaveBeenCalled();
  });

  it("fails a second active job of the same type", async () => {
    const { req, put } = setup({ others: [{ id: "other" }] });
    await handler(req);
    expect(put).toHaveBeenCalledWith(`/syncs/${JOB_ID}`, expect.objectContaining({
      status: "failed",
      last_error: "Another stock sync is already active. Cancel it first.",
    }));
  });

  it.each([
    ["the app is disabled", { enabled: false }, "The Katana app is turned off in settings"],
    ["credentials are missing", { location_id: undefined }, "Katana API key or Location ID is not set in the app settings"],
    ["inventory sync is off", { sync_inventory: false }, '"Sync inventory from Katana" is off in the app settings'],
  ])("fails when %s", async (_name, override, message) => {
    const { req, put } = setup({ settings: { ...SETTINGS, ...override } });
    await handler(req);
    expect(put).toHaveBeenCalledWith(`/syncs/${JOB_ID}`, expect.objectContaining({ status: "failed", last_error: message }));
  });

  it("pauses the job after a retryable error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(katanaFetch({ "GET /inventory": () => jsonResponse({ message: "busy" }, 429) }) as any);
    const { req, put } = setup({ job: { id: JOB_ID, type: "inventory", status: "running", retries: 1 }, event: { type: "sync.updated", data: { pages: 3 } } });
    await handler(req);
    expect(put).toHaveBeenCalledWith(`/syncs/${JOB_ID}`, {
      status: "waiting",
      retries: 2,
      date_retry: expect.any(String),
      last_error: expect.stringMatching(/^Katana 429: busy Retry 2 of 8 at /),
    });
  });

  it("fails after a non-retryable error or too many retries", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(katanaFetch({ "GET /inventory": () => jsonResponse({ message: "Unauthorized" }, 401) }) as any);
    const unauthorized = setup();
    await handler(unauthorized.req);
    expect(unauthorized.put).toHaveBeenCalledWith(`/syncs/${JOB_ID}`, expect.objectContaining({ status: "failed", last_error: "Katana 401: Unauthorized" }));

    vi.spyOn(globalThis, "fetch").mockImplementation(katanaFetch({ "GET /inventory": () => jsonResponse({ message: "down" }, 503) }) as any);
    const exhausted = setup({ job: { id: JOB_ID, type: "inventory", status: "running", retries: MAX_RETRIES }, event: { type: "sync.updated", data: { pages: 3 } } });
    await handler(exhausted.req);
    expect(exhausted.put).toHaveBeenCalledWith(`/syncs/${JOB_ID}`, expect.objectContaining({
      status: "failed",
      last_error: `Katana 503: down Gave up after ${MAX_RETRIES} retries.`,
    }));
  });
});

describe("save", () => {
  it("keeps a cancel made while the step ran", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ status: "canceled" }), put: vi.fn() } as any;
    await save(swell, { id: "j", type: "inventory", status: "running", date_started: "t" }, { pages: 2, status: "completed" });
    expect(swell.put).toHaveBeenCalledWith("/syncs/j", { pages: 2 });
  });

  it("clears the retry state after a successful step", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ status: "running" }), put: vi.fn() } as any;
    await save(swell, { id: "j", type: "inventory", status: "running", date_started: "t", retries: 3 }, { pages: 2 });
    expect(swell.put).toHaveBeenCalledWith("/syncs/j", { pages: 2, retries: 0, date_retry: null, status: "running" });
  });
});
