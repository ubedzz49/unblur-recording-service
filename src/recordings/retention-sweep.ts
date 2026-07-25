import { RecordingProvider } from "./retention-provider.js";
import { logger } from "../logger.js";

// deletes every recording older than the retention window -- the "15 minute temporary retention
// window" from the design doc. Daily's own recordings list is the source of truth; nothing about
// which recordings exist is mirrored in this service's own DB.
export async function sweepExpiredRecordings(
  provider: RecordingProvider,
  retentionMins: number,
  now: number = Date.now(),
): Promise<{ deleted: string[]; failed: string[] }> {
  const cutoffSeconds = now / 1000 - retentionMins * 60;
  const recordings = await provider.listRecordings();
  const expired = recordings.filter((r) => r.startTs <= cutoffSeconds);

  const deleted: string[] = [];
  const failed: string[] = [];
  for (const recording of expired) {
    try {
      await provider.deleteRecording(recording.id);
      deleted.push(recording.id);
    } catch (err) {
      // one bad recording (already gone, transient Daily API error) shouldn't stop the sweep
      // from processing the rest -- retried again on the next tick regardless
      logger.warn({ err, recordingId: recording.id }, "failed to delete expired recording, will retry next sweep");
      failed.push(recording.id);
    }
  }
  return { deleted, failed };
}

// runs the sweep on a fixed interval for as long as the process lives -- this service is a
// long-running Fargate task, same as every other service here, so a plain setInterval is enough;
// no separate cron/scheduler infra needed for a 15-minute-scale retention window
export function startRetentionSweeper(
  provider: RecordingProvider,
  retentionMins: number,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    sweepExpiredRecordings(provider, retentionMins).catch((err) => {
      logger.error({ err }, "recording retention sweep failed");
    });
  }, intervalMs);
}
