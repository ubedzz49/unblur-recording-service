import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyRecordingProvider } from "./retention-provider.js";

describe("DailyRecordingProvider", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DAILY_API_KEY;

  beforeEach(() => {
    process.env.DAILY_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.DAILY_API_KEY = originalKey;
  });

  it("lists recordings from Daily's own recordings API", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "rec-1", room_name: "room-1", start_ts: 1000 }] }),
    }) as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    const recordings = await provider.listRecordings();
    expect(recordings).toEqual([{ id: "rec-1", roomName: "room-1", startTs: 1000 }]);
  });

  it("throws with Daily's error body on a non-ok list response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"unauthorized"}',
    }) as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    await expect(provider.listRecordings()).rejects.toThrow(/daily list recordings failed: 401/);
  });

  it("deletes a recording by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    await provider.deleteRecording("rec-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.daily.co/v1/recordings/rec-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws with Daily's error body on a non-ok delete response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"not-found"}',
    }) as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    await expect(provider.deleteRecording("gone")).rejects.toThrow(/daily delete recording failed: 404/);
  });

  it("throws clearly if DAILY_API_KEY is unset", async () => {
    delete process.env.DAILY_API_KEY;
    const provider = new DailyRecordingProvider();
    await expect(provider.listRecordings()).rejects.toThrow(/DAILY_API_KEY/);
  });
});
