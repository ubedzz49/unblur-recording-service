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

  it("getAccessLinkForRoom looks up the recording by room then fetches its access link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "rec-1" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ download_link: "https://daily.example/rec-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    const url = await provider.getAccessLinkForRoom("room-1");

    expect(url).toBe("https://daily.example/rec-1");
    expect(fetchMock.mock.calls[0][0]).toContain("room_name=room-1");
    expect(fetchMock.mock.calls[1][0]).toContain("/recordings/rec-1/access-link");
  });

  it("getAccessLinkForRoom returns null when no recording exists for that room", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    expect(await provider.getAccessLinkForRoom("room-1")).toBeNull();
  });

  it("getAccessLinkForRoom throws with Daily's error body on a non-ok list response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"unauthorized"}',
    }) as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    await expect(provider.getAccessLinkForRoom("room-1")).rejects.toThrow(/daily list recordings failed: 401/);
  });

  it("getAccessLinkForRoom throws with Daily's error body on a non-ok access-link response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "rec-1" }] }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"error":"not-found"}' });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new DailyRecordingProvider();
    await expect(provider.getAccessLinkForRoom("room-1")).rejects.toThrow(/daily get access-link failed: 404/);
  });
});
