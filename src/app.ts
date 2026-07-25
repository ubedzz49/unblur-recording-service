import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BookingClient, FakeBookingClient } from "./bookings/client.js";
import {
  Complaint,
  ComplaintOutcome,
  ComplaintsRepository,
  DuplicateComplaintError,
  InMemoryComplaintsRepository,
} from "./recordings/complaints-repository.js";

interface CreateComplaintBody {
  bookingId?: string;
  reason?: string;
}

interface ResolveComplaintBody {
  outcome?: string;
}

const VALID_OUTCOMES: ComplaintOutcome[] = ["upheld", "dismissed"];

export function buildApp(
  complaintsRepository: ComplaintsRepository = new InMemoryComplaintsRepository(),
  bookingClient: BookingClient = new FakeBookingClient(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });

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

  // user-facing routes trust the gateway-verified X-User-Id header, same pattern every other
  // service in this project uses -- this service never verifies JWTs itself
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/internal/") || request.url === "/healthz") return;
    const userId = request.headers["x-user-id"];
    if (!userId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }
  });

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

  return app;
}
