import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BookingClient, FakeBookingClient } from "./bookings/client.js";
import { FakeRecordingProvider, RecordingProvider } from "./recordings/retention-provider.js";
import { logger } from "./logger.js";
import {
  Complaint,
  ComplaintOutcome,
  ComplaintsRepository,
  ComplaintStatus,
  DuplicateComplaintError,
  InMemoryComplaintsRepository,
} from "./recordings/complaints-repository.js";
import { AuditLogClient, FakeAuditLogClient } from "./admin/audit-log-client.js";

interface CreateComplaintBody {
  bookingId?: string;
  reason?: string;
}

interface ResolveComplaintBody {
  outcome?: string;
}

interface ListComplaintsQuery {
  status?: string;
}

const VALID_OUTCOMES: ComplaintOutcome[] = ["upheld", "dismissed"];
const VALID_STATUSES: ComplaintStatus[] = ["open", "resolved"];

export function buildApp(
  complaintsRepository: ComplaintsRepository = new InMemoryComplaintsRepository(),
  bookingClient: BookingClient = new FakeBookingClient(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
  recordingProvider: RecordingProvider = new FakeRecordingProvider(),
  auditLogClient: AuditLogClient = new FakeAuditLogClient(),
): FastifyInstance {
  const app = Fastify(
    process.env.NODE_ENV === "test"
      ? { logger: false }
      : { loggerInstance: logger as unknown as FastifyBaseLogger },
  );

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for no-body calls -- real clients send that header unconditionally, so this bites
  // any no-body call otherwise (see ARCHITECTURE_DECISIONS.md)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // internal routes are only ever called by other services (Payment Service checking a booking's
  // complaint status before releasing a held payout), never the frontend directly
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/internal/")) return;
    const token = request.headers["x-internal-service-token"];
    if (!token || token !== internalServiceToken) {
      request.log.warn("rejected internal request with missing/invalid service token");
      return reply.code(401).send({ error: "invalid internal service token" });
    }
  });

  const VALID_LOG_LEVELS = ["info", "debug", "error"];

  // runtime-mutable logging verbosity, no redeploy needed -- see src/logger.ts for the custom
  // info<debug<error severity ordering this project uses (not pino's default trace<debug<info<
  // warn<error<fatal). Gated the same as every other /internal/ route.
  app.get("/internal/log-level", async (_request, reply) => {
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: { level?: string } }>("/internal/log-level", async (request, reply) => {
    const { level } = request.body ?? {};
    if (typeof level !== "string" || !VALID_LOG_LEVELS.includes(level)) {
      return reply.code(400).send({ error: `level must be one of ${VALID_LOG_LEVELS.join(", ")}` });
    }
    logger.level = level;
    request.log.info({ level }, "log level changed at runtime");
    return reply.send({ level: logger.level });
  });

  // user-facing routes trust the gateway-verified X-User-Id header, same pattern every other
  // service in this project uses -- this service never verifies JWTs itself
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/internal/") || request.url === "/healthz") return;
    const userId = request.headers["x-user-id"];
    if (!userId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }
  });

  // admin routes trust the gateway-forwarded role header, same as X-User-Id -- the gateway
  // itself already rejects any /admin/ request without role: admin before it ever reaches here,
  // this is defense-in-depth in case that route ever gets called some other way
  function requireAdminRole(request: FastifyRequest, reply: FastifyReply): boolean {
    const role = request.headers["x-user-role"];
    if (role !== "admin" && role !== "superadmin") {
      reply.code(403).send({ error: "admin access required" });
      return false;
    }
    return true;
  }

  app.post<{ Body: CreateComplaintBody }>("/complaints", async (request, reply) => {
    const callerUserId = request.headers["x-user-id"] as string;
    const { bookingId, reason } = request.body ?? {};

    if (typeof bookingId !== "string" || bookingId.length === 0) {
      return reply.code(400).send({ error: "bookingId is required" });
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return reply.code(400).send({ error: "reason is required" });
    }

    const booking = await bookingClient.getBooking(bookingId, callerUserId);
    if (!booking) {
      return reply.code(404).send({ error: "booking not found" });
    }
    // only the booking's poster can report an issue -- matches ratings' same restriction
    if (booking.posterUserId !== callerUserId) {
      return reply.code(403).send({ error: "only the booking's poster can report an issue" });
    }
    if (booking.status !== "completed") {
      return reply.code(409).send({ error: "can only report an issue on a completed booking" });
    }

    try {
      const complaint = await complaintsRepository.createComplaint({
        bookingId,
        complainantUserId: callerUserId,
        reason: reason.trim(),
      });
      request.log.info({ complaintId: complaint.id, bookingId }, "complaint filed");
      return reply.code(201).send(complaint);
    } catch (err) {
      // one complaint per booking -- a poster reporting the same session twice sees their
      // existing complaint rather than an error
      if (err instanceof DuplicateComplaintError) {
        const existing = await complaintsRepository.getByBookingId(bookingId);
        return reply.code(200).send(existing);
      }
      throw err;
    }
  });

  app.get<{ Params: { bookingId: string } }>("/complaints/:bookingId", async (request, reply) => {
    const callerUserId = request.headers["x-user-id"] as string;
    const complaint = await complaintsRepository.getByBookingId(request.params.bookingId);
    if (!complaint) {
      return reply.code(404).send({ error: "no complaint for this booking" });
    }
    if (complaint.complainantUserId !== callerUserId) {
      return reply.code(403).send({ error: "not authorized to view this complaint" });
    }
    return reply.send(complaint);
  });

  app.get<{ Params: { bookingId: string } }>(
    "/internal/complaints/by-booking/:bookingId",
    async (request, reply) => {
      const complaint = await complaintsRepository.getByBookingId(request.params.bookingId);
      return reply.send({ complaint });
    },
  );

  app.post<{ Params: { id: string }; Body: ResolveComplaintBody }>(
    "/internal/complaints/:id/resolve",
    async (request, reply) => {
      const { outcome } = request.body ?? {};
      if (typeof outcome !== "string" || !VALID_OUTCOMES.includes(outcome as ComplaintOutcome)) {
        return reply.code(400).send({ error: `outcome must be one of ${VALID_OUTCOMES.join(", ")}` });
      }

      const existing = await complaintsRepository.getById(request.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "complaint not found" });
      }
      if (existing.status === "resolved") {
        return reply.code(409).send({ error: "complaint is already resolved" });
      }

      const resolved: Complaint | null = await complaintsRepository.resolve(request.params.id, outcome as ComplaintOutcome);
      request.log.info({ complaintId: request.params.id, outcome }, "complaint resolved");
      return reply.send(resolved);
    },
  );

  app.get<{ Querystring: ListComplaintsQuery }>("/admin/complaints", async (request, reply) => {
    if (!requireAdminRole(request, reply)) return;

    const { status } = request.query ?? {};
    if (status !== undefined && !VALID_STATUSES.includes(status as ComplaintStatus)) {
      return reply.code(400).send({ error: `status must be one of ${VALID_STATUSES.join(", ")}` });
    }

    const complaints = await complaintsRepository.listAll(status as ComplaintStatus | undefined);
    return reply.send(complaints);
  });

  app.post<{ Params: { id: string }; Body: ResolveComplaintBody }>(
    "/admin/complaints/:id/resolve",
    async (request, reply) => {
      if (!requireAdminRole(request, reply)) return;

      const { outcome } = request.body ?? {};
      if (typeof outcome !== "string" || !VALID_OUTCOMES.includes(outcome as ComplaintOutcome)) {
        return reply.code(400).send({ error: `outcome must be one of ${VALID_OUTCOMES.join(", ")}` });
      }

      const existing = await complaintsRepository.getById(request.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "complaint not found" });
      }
      if (existing.status === "resolved") {
        return reply.code(409).send({ error: "complaint is already resolved" });
      }

      const resolved = await complaintsRepository.resolve(request.params.id, outcome as ComplaintOutcome);
      await auditLogClient.record({
        adminUserId: (request.headers["x-user-id"] as string) ?? "unknown",
        adminUsername: (request.headers["x-user-username"] as string) ?? "unknown",
        action: "resolve_complaint",
        targetType: "complaint",
        targetId: request.params.id,
        metadata: { outcome, bookingId: existing.bookingId },
      });
      request.log.info({ complaintId: request.params.id, outcome }, "complaint resolved by admin");
      return reply.send(resolved);
    },
  );

  app.get<{ Params: { id: string } }>("/admin/complaints/:id/recording", async (request, reply) => {
    if (!requireAdminRole(request, reply)) return;

    const complaint = await complaintsRepository.getById(request.params.id);
    if (!complaint) {
      return reply.code(404).send({ error: "complaint not found" });
    }

    const booking = await bookingClient.getBookingAsAdmin(complaint.bookingId);
    if (!booking || !booking.providerRoomId) {
      return reply.code(404).send({ error: "no meeting room on record for this booking" });
    }

    let url: string | null;
    try {
      url = await recordingProvider.getAccessLinkForRoom(booking.providerRoomId);
    } catch (err) {
      request.log.error({ err, complaintId: complaint.id }, "failed to fetch recording access link");
      return reply.code(502).send({ error: "couldn't fetch the recording right now, try again" });
    }

    if (!url) {
      return reply.code(404).send({ error: "no recording available -- it may already have been deleted" });
    }
    return reply.send({ url });
  });

  return app;
}
