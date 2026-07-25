import { buildApp } from "./app.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresComplaintsRepository } from "./recordings/postgres-complaints-repository.js";
import { HttpBookingClient } from "./bookings/client.js";
import { DailyRecordingProvider } from "./recordings/retention-provider.js";
import { startRetentionSweeper } from "./recordings/retention-sweep.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3009);
const retentionMins = Number(process.env.RECORDING_RETENTION_MINS ?? 15);

// fail closed, same philosophy as every other service's INTERNAL_SERVICE_TOKEN check -- an unset
// token would otherwise mean this service silently accepts any internal request
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  logger.fatal("INTERNAL_SERVICE_TOKEN is not set, refusing to start");
  process.exit(1);
}

const dbPool = buildDbPool();

runMigrations(dbPool)
  .then(() => {
    const app = buildApp(
      new PostgresComplaintsRepository(dbPool),
      new HttpBookingClient(),
      process.env.INTERNAL_SERVICE_TOKEN,
    );

    // only runs against real Daily.co if a key is configured -- keeps local/test boot working
    // without one, same as meeting-service's DailyVideoProvider only being reached at call time
    if (process.env.DAILY_API_KEY) {
      startRetentionSweeper(new DailyRecordingProvider(), retentionMins);
    } else {
      logger.warn("DAILY_API_KEY not set, recording retention sweep disabled");
    }

    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info({ port }, "recording-service listening"));
  })
  .catch((err) => {
    logger.error({ err }, "recording-service failed to start");
    process.exit(1);
  });
