import { describe, it, expect, vi } from "vitest";
import handler from "../../functions/sync-retry";
import { createMockRequest } from "../helpers/mock-request";

function setup(job: Record<string, any> | null) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({ data: { id: "j1" } as any, swell: { get: vi.fn().mockResolvedValue(job), put } });
  return { req, put };
}

describe("sync-retry", () => {
  it("sets a waiting job back to pending", async () => {
    const { req, put } = setup({ id: "j1", status: "waiting" });
    await handler(req);
    expect(put).toHaveBeenCalledWith("/syncs/j1", { status: "pending" });
  });

  it("leaves jobs canceled or resumed in the meantime alone", async () => {
    for (const job of [null, { id: "j1", status: "canceled" }, { id: "j1", status: "running" }]) {
      const { req, put } = setup(job);
      await handler(req);
      expect(put).not.toHaveBeenCalled();
    }
  });
});
