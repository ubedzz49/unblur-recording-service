import { RecordingProvider } from "./retention-provider.js";
import { ComplaintsRepository } from "./complaints-repository.js";
import { logger } from "../logger.js";

// meeting-service names a resolution room "resolution-<booking-uuid>-<16 hex chars>" (see its
// src/app.ts) -- parsed back out here so the sweep can check whether a recording's booking has
// an open complaint before deleting it. Returns null for anything that doesn't match (a room
// from some future, non-resolution room type, for instance).
const ROOM_NAME_PATTERN = /^resolution-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]{16}$/i;

export function parseBookingIdFromRoomName(roomName: string): string | null {
  return ROOM_NAME_PATTERN.exec(roomName)?.[1] ?? null;
}

// deletes every recording older than the retention window -- the "15 minute temporary retention
// window" from the design doc -- unless its booking has an open complaint, in which case it's
// kept around so the admin dashboard can still play it back while the complaint is under review.
// Daily's own recordings list is the source of truth; nothing about which recordings exist is
// mirrored in this service's own DB.
export async function sweepExpiredRecordings(
  provider: RecordingProvider,
  complaintsRepository: ComplaintsRepository,
  retentionMins: number,
  now: number = Date.now(),
): Promise<{ deleted: string[]; retainedForComplaint: string[]; failed: string[] }> {
  const cutoffSeconds = now / 1000 - retentionMins * 60;
  const recordings = await provider.listRecordings();
  const expired = recordings.filter((r) => r.startTs <= cutoffSeconds);

  const deleted: string[] = [];
  const retainedForComplaint: string[] = [];
  const failed: string[] = [];
  for (const recording of expired) {
    try {
      const bookingId = parseBookingIdFromRoomName(recording.roomName);
      if (bookingId) {
        const complaint = await complaintsRepository.getByBookingId(bookingId);
        if (complaint && complaint.status === "open") {
          retainedForComplaint.push(recording.id);
          continue;
        }
      }
      await provider.deleteRecording(recording.id);
      deleted.push(recording.id);
    } catch (err) {
      // one bad recording (already gone, transient Daily API error) shouldn't stop the sweep
      // from processing the rest -- retried again on the next tick regardless
      logger.warn({ err, recordingId: recording.id }, "failed to delete expired recording, will retry next sweep");
      failed.push(recording.id);
    }
  }
  return { deleted, retainedForComplaint, failed };
}

// runs the sweep on a fixed interval for as long as the process lives -- this service is a
// long-running Fargate task, same as every other service here, so a plain setInterval is enough;
// no separate cron/scheduler infra needed for a 15-minute-scale retention window
export function startRetentionSweeper(
  provider: RecordingProvider,
  complaintsRepository: ComplaintsRepository,
  retentionMins: number,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    sweepExpiredRecordings(provider, complaintsRepository, retentionMins).catch((err) => {
      logger.error({ err }, "recording retention sweep failed");
    });
  }, intervalMs);
}
