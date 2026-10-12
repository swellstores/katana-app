import { describe, it, expect, vi } from "vitest";
import handler from "../../functions/sync-control";
import { createMockRequest } from "../helpers/mock-request";

const ID = "6ac623e9bf440b0012d66600";

function setup(action: string, job: Record<string, any> | null, active: Record<string, any>[] = [], recordId = ID) {
  const put = vi.fn().mockResolvedValue({});
  const get = vi.fn(async (url: string) => (url === "/syncs" ? { results: active } : job));
  const req = createMockRequest({ data: { $action: { id: action, record_id: recordId } } as any, swell: { get, put } });
  return { req, put };
}

describe("sync-control", () => {
  it("cancels an active job", async () => {
    const { req, put } = setup("cancel", { id: ID, status: "running" });
    expect(await handler(req)).toEqual({ message: "Sync canceled." });
    expect(put).toHaveBeenCalledWith(`/syncs/${ID}`, { status: "canceled", date_completed: expect.any(String) });
  });

  it("doesn't cancel a finished job", async () => {
    const { req, put } = setup("cancel", { id: ID, status: "completed" });
    expect(await handler(req)).toEqual({ message: "This sync is already completed." });
    expect(put).not.toHaveBeenCalled();
  });

  it("resumes a failed job", async () => {
    const { req, put } = setup("resume", { id: ID, type: "orders", status: "failed" });
    expect(await handler(req)).toEqual({ message: "Sync resumed." });
    expect(put).toHaveBeenCalledWith(`/syncs/${ID}`, { status: "pending", last_error: null, date_completed: null, retries: 0, date_retry: null });
  });

  it("resumes a waiting job right away", async () => {
    const job = { id: ID, type: "orders", status: "waiting" };
    const { req, put } = setup("resume", job, [job]);
    expect(await handler(req)).toEqual({ message: "Sync resumed." });
    expect(put).toHaveBeenCalled();
  });

  it("doesn't resume while another job of the type is active", async () => {
    const { req, put } = setup("resume", { id: ID, type: "orders", status: "canceled" }, [{ id: "other", status: "running" }]);
    expect(await handler(req)).toEqual({ message: "Another sync of this type is active. Cancel it or wait for it to finish first." });
    expect(put).not.toHaveBeenCalled();
  });

  it("doesn't resume a running or completed job", async () => {
    const { req } = setup("resume", { id: ID, status: "completed" });
    expect(await handler(req)).toEqual({ message: "Only failed, canceled or waiting syncs can be resumed. This one is completed." });
  });

  it("validates the record and the action", async () => {
    await expect(handler(setup("cancel", null, [], "../x").req)).rejects.toMatchObject({ status: 400 });
    await expect(handler(setup("cancel", null).req)).rejects.toMatchObject({ status: 404 });
    await expect(handler(setup("nope", { id: ID, status: "running" }).req)).rejects.toMatchObject({ status: 400 });
  });
});
