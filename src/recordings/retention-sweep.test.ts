import { describe, expect, it } from "vitest";
import { sweepExpiredRecordings } from "./retention-sweep.js";
import { FakeRecordingProvider } from "./retention-provider.js";

const RETENTION_MINS = 15;

describe("sweepExpiredRecordings", () => {
  it("deletes a recording older than the retention window", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [{ id: "rec-1", roomName: "room-1", startTs: now / 1000 - 20 * 60 }];

    const result = await sweepExpiredRecordings(provider, RETENTION_MINS, now);
    expect(result.deleted).toEqual(["rec-1"]);
    expect(provider.deleteCalls).toEqual(["rec-1"]);
  });

  it("leaves a recording within the retention window alone", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [{ id: "rec-1", roomName: "room-1", startTs: now / 1000 - 5 * 60 }];

    const result = await sweepExpiredRecordings(provider, RETENTION_MINS, now);
    expect(result.deleted).toEqual([]);
    expect(provider.deleteCalls).toEqual([]);
  });

  it("deletes a recording exactly at the retention boundary", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [{ id: "rec-1", roomName: "room-1", startTs: now / 1000 - RETENTION_MINS * 60 }];

    const result = await sweepExpiredRecordings(provider, RETENTION_MINS, now);
    expect(result.deleted).toEqual(["rec-1"]);
  });

  it("processes multiple recordings independently, only deleting the expired ones", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [
      { id: "old-1", roomName: "room-1", startTs: now / 1000 - 30 * 60 },
      { id: "fresh-1", roomName: "room-2", startTs: now / 1000 - 2 * 60 },
      { id: "old-2", roomName: "room-3", startTs: now / 1000 - 16 * 60 },
    ];

    const result = await sweepExpiredRecordings(provider, RETENTION_MINS, now);
    expect(result.deleted.sort()).toEqual(["old-1", "old-2"]);
  });

  it("continues past a delete failure and reports it separately, rather than aborting the whole sweep", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [
      { id: "will-fail", roomName: "room-1", startTs: now / 1000 - 30 * 60 },
      { id: "will-succeed", roomName: "room-2", startTs: now / 1000 - 30 * 60 },
    ];
    const originalDelete = provider.deleteRecording.bind(provider);
    provider.deleteRecording = async (id: string) => {
      if (id === "will-fail") throw new Error("daily delete recording failed: 500");
      return originalDelete(id);
    };

    const result = await sweepExpiredRecordings(provider, RETENTION_MINS, now);
    expect(result.deleted).toEqual(["will-succeed"]);
    expect(result.failed).toEqual(["will-fail"]);
  });

  it("does nothing when there are no recordings at all", async () => {
    const provider = new FakeRecordingProvider();
    const result = await sweepExpiredRecordings(provider, RETENTION_MINS);
    expect(result).toEqual({ deleted: [], failed: [] });
  });
});
