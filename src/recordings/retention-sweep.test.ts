import { describe, expect, it } from "vitest";
import { parseBookingIdFromRoomName, sweepExpiredRecordings } from "./retention-sweep.js";
import { FakeRecordingProvider } from "./retention-provider.js";
import { InMemoryComplaintsRepository } from "./complaints-repository.js";

const RETENTION_MINS = 15;
const BOOKING_ID = "11111111-1111-1111-1111-111111111111";

describe("parseBookingIdFromRoomName", () => {
  it("extracts the booking uuid from a real meeting-service room name", () => {
    const roomName = `resolution-${BOOKING_ID}-a1b2c3d4e5f6a7b8`;
    expect(parseBookingIdFromRoomName(roomName)).toBe(BOOKING_ID);
  });

  it("returns null for a name that doesn't match the resolution room pattern", () => {
    expect(parseBookingIdFromRoomName("some-other-room")).toBeNull();
  });
});

describe("sweepExpiredRecordings", () => {
  it("deletes a recording older than the retention window", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [{ id: "rec-1", roomName: "room-1", startTs: now / 1000 - 20 * 60 }];

    const result = await sweepExpiredRecordings(provider, new InMemoryComplaintsRepository(), RETENTION_MINS, now);
    expect(result.deleted).toEqual(["rec-1"]);
    expect(provider.deleteCalls).toEqual(["rec-1"]);
  });

  it("leaves a recording within the retention window alone", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [{ id: "rec-1", roomName: "room-1", startTs: now / 1000 - 5 * 60 }];

    const result = await sweepExpiredRecordings(provider, new InMemoryComplaintsRepository(), RETENTION_MINS, now);
    expect(result.deleted).toEqual([]);
    expect(provider.deleteCalls).toEqual([]);
  });

  it("deletes a recording exactly at the retention boundary", async () => {
    const provider = new FakeRecordingProvider();
    const now = Date.now();
    provider.recordings = [{ id: "rec-1", roomName: "room-1", startTs: now / 1000 - RETENTION_MINS * 60 }];

    const result = await sweepExpiredRecordings(provider, new InMemoryComplaintsRepository(), RETENTION_MINS, now);
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

    const result = await sweepExpiredRecordings(provider, new InMemoryComplaintsRepository(), RETENTION_MINS, now);
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

    const result = await sweepExpiredRecordings(provider, new InMemoryComplaintsRepository(), RETENTION_MINS, now);
    expect(result.deleted).toEqual(["will-succeed"]);
    expect(result.failed).toEqual(["will-fail"]);
  });

  it("does nothing when there are no recordings at all", async () => {
    const provider = new FakeRecordingProvider();
    const result = await sweepExpiredRecordings(provider, new InMemoryComplaintsRepository(), RETENTION_MINS);
    expect(result).toEqual({ deleted: [], retainedForComplaint: [], failed: [] });
  });

  it("retains a recording whose booking has an open complaint, instead of deleting it", async () => {
    const provider = new FakeRecordingProvider();
    const complaintsRepository = new InMemoryComplaintsRepository();
    await complaintsRepository.createComplaint({
      bookingId: BOOKING_ID,
      complainantUserId: "poster-1",
      reason: "resolver left early",
    });
    const now = Date.now();
    const roomName = `resolution-${BOOKING_ID}-a1b2c3d4e5f6a7b8`;
    provider.recordings = [{ id: "rec-1", roomName, startTs: now / 1000 - 20 * 60 }];

    const result = await sweepExpiredRecordings(provider, complaintsRepository, RETENTION_MINS, now);
    expect(result.retainedForComplaint).toEqual(["rec-1"]);
    expect(result.deleted).toEqual([]);
    expect(provider.deleteCalls).toEqual([]);
  });

  it("deletes a recording once its complaint is resolved", async () => {
    const provider = new FakeRecordingProvider();
    const complaintsRepository = new InMemoryComplaintsRepository();
    const complaint = await complaintsRepository.createComplaint({
      bookingId: BOOKING_ID,
      complainantUserId: "poster-1",
      reason: "resolver left early",
    });
    await complaintsRepository.resolve(complaint.id, "dismissed");
    const now = Date.now();
    const roomName = `resolution-${BOOKING_ID}-a1b2c3d4e5f6a7b8`;
    provider.recordings = [{ id: "rec-1", roomName, startTs: now / 1000 - 20 * 60 }];

    const result = await sweepExpiredRecordings(provider, complaintsRepository, RETENTION_MINS, now);
    expect(result.deleted).toEqual(["rec-1"]);
    expect(result.retainedForComplaint).toEqual([]);
  });
});
