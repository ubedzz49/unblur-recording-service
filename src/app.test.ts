import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryComplaintsRepository } from "./recordings/complaints-repository.js";
import { FakeBookingClient } from "./bookings/client.js";
import { FakeRecordingProvider } from "./recordings/retention-provider.js";

const INTERNAL_TOKEN = "test-internal-token";
const POSTER = "11111111-1111-1111-1111-111111111111";
const RESOLVER = "22222222-2222-2222-2222-222222222222";
const OTHER_USER = "33333333-3333-3333-3333-333333333333";
const BOOKING_ID = "44444444-4444-4444-4444-444444444444";
const PROVIDER_ROOM_ID = `resolution-${BOOKING_ID}-a1b2c3d4e5f6a7b8`;

function setup(bookingStatus = "completed") {
  const repo = new InMemoryComplaintsRepository();
  const bookingClient = new FakeBookingClient();
  bookingClient.seed({
    id: BOOKING_ID,
    posterUserId: POSTER,
    resolverUserId: RESOLVER,
    status: bookingStatus,
    providerRoomId: PROVIDER_ROOM_ID,
  });
  const recordingProvider = new FakeRecordingProvider();
  const app = buildApp(repo, bookingClient, INTERNAL_TOKEN, recordingProvider);
  return { app, repo, bookingClient, recordingProvider };
}

function fileComplaint(app: ReturnType<typeof buildApp>, userId = POSTER, body: Record<string, unknown> = { bookingId: BOOKING_ID, reason: "resolver left after 2 minutes" }) {
  return app.inject({ method: "POST", url: "/complaints", headers: { "x-user-id": userId }, payload: body });
}

describe("GET /healthz", () => {
  it("returns ok status with no auth required", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("401s a user-facing route with no X-User-Id", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/complaints", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401s an internal route with no service token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: `/internal/complaints/by-booking/${BOOKING_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it("401s an internal route with a wrong service token", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: `/internal/complaints/by-booking/${BOOKING_ID}`,
      headers: { "x-internal-service-token": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /complaints", () => {
  it("rejects a missing bookingId", async () => {
    const { app } = setup();
    const res = await fileComplaint(app, POSTER, { reason: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing reason", async () => {
    const { app } = setup();
    const res = await fileComplaint(app, POSTER, { bookingId: BOOKING_ID });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a blank reason", async () => {
    const { app } = setup();
    const res = await fileComplaint(app, POSTER, { bookingId: BOOKING_ID, reason: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown booking", async () => {
    const { app } = setup();
    const res = await fileComplaint(app, POSTER, { bookingId: "does-not-exist", reason: "issue" });
    expect(res.statusCode).toBe(404);
  });

  it("404s (not 403) for a third party uninvolved in the booking -- doesn't leak that the booking exists", async () => {
    const { app } = setup();
    const res = await fileComplaint(app, OTHER_USER);
    expect(res.statusCode).toBe(404);
  });

  it("403s the resolver trying to file a complaint on their own session", async () => {
    const { app } = setup();
    const res = await fileComplaint(app, RESOLVER);
    expect(res.statusCode).toBe(403);
  });

  it("409s filing a complaint on a booking that isn't completed yet", async () => {
    const { app } = setup("scheduled");
    const res = await fileComplaint(app, POSTER);
    expect(res.statusCode).toBe(409);
  });

  it("201s and creates the complaint for the poster on a completed booking", async () => {
    const { app } = setup();
    const res = await fileComplaint(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.bookingId).toBe(BOOKING_ID);
    expect(body.complainantUserId).toBe(POSTER);
    expect(body.status).toBe("open");
    expect(body.outcome).toBeNull();
  });

  it("is idempotent -- filing twice returns the existing complaint (200) instead of erroring", async () => {
    const { app } = setup();
    const first = await fileComplaint(app);
    const second = await fileComplaint(app);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it("accepts an empty body with Content-Type: application/json set (real client behavior)", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/complaints",
      headers: { "x-user-id": POSTER, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /complaints/:bookingId", () => {
  it("404s when no complaint exists for the booking", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: `/complaints/${BOOKING_ID}`, headers: { "x-user-id": POSTER } });
    expect(res.statusCode).toBe(404);
  });

  it("200s for the complainant", async () => {
    const { app } = setup();
    await fileComplaint(app);
    const res = await app.inject({ method: "GET", url: `/complaints/${BOOKING_ID}`, headers: { "x-user-id": POSTER } });
    expect(res.statusCode).toBe(200);
    expect(res.json().bookingId).toBe(BOOKING_ID);
  });

  it("403s for anyone else, including the resolver the complaint is about", async () => {
    const { app } = setup();
    await fileComplaint(app);
    const res = await app.inject({ method: "GET", url: `/complaints/${BOOKING_ID}`, headers: { "x-user-id": RESOLVER } });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /internal/complaints/by-booking/:bookingId", () => {
  it("returns { complaint: null } when none exists", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: `/internal/complaints/by-booking/${BOOKING_ID}`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ complaint: null });
  });

  it("returns the complaint when one exists", async () => {
    const { app } = setup();
    await fileComplaint(app);
    const res = await app.inject({
      method: "GET",
      url: `/internal/complaints/by-booking/${BOOKING_ID}`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.json().complaint.bookingId).toBe(BOOKING_ID);
  });
});

describe("POST /internal/complaints/:id/resolve", () => {
  it("400s an invalid outcome", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    const res = await app.inject({
      method: "POST",
      url: `/internal/complaints/${filed.json().id}/resolve`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { outcome: "maybe" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown complaint", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/complaints/does-not-exist/resolve",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { outcome: "upheld" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("resolves a complaint as upheld", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    const res = await app.inject({
      method: "POST",
      url: `/internal/complaints/${filed.json().id}/resolve`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { outcome: "upheld" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("resolved");
    expect(res.json().outcome).toBe("upheld");
  });

  it("409s resolving an already-resolved complaint", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    await app.inject({
      method: "POST",
      url: `/internal/complaints/${filed.json().id}/resolve`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { outcome: "dismissed" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/internal/complaints/${filed.json().id}/resolve`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { outcome: "upheld" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("GET /admin/complaints", () => {
  it("403s a non-admin caller", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/admin/complaints", headers: { "x-user-id": POSTER } });
    expect(res.statusCode).toBe(403);
  });

  it("lists all complaints for an admin caller", async () => {
    const { app } = setup();
    await fileComplaint(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin/complaints",
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("filters by status", async () => {
    const { app } = setup();
    await fileComplaint(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin/complaints?status=resolved",
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  it("400s an invalid status", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/admin/complaints?status=bogus",
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /admin/complaints/:id/resolve", () => {
  it("403s a non-admin caller", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    const res = await app.inject({
      method: "POST",
      url: `/admin/complaints/${filed.json().id}/resolve`,
      headers: { "x-user-id": POSTER },
      payload: { outcome: "upheld" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("resolves a complaint as an admin", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    const res = await app.inject({
      method: "POST",
      url: `/admin/complaints/${filed.json().id}/resolve`,
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
      payload: { outcome: "upheld" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("resolved");
    expect(res.json().outcome).toBe("upheld");
  });

  it("404s an unknown complaint", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/admin/complaints/does-not-exist/resolve",
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
      payload: { outcome: "upheld" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /admin/complaints/:id/recording", () => {
  it("403s a non-admin caller", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    const res = await app.inject({
      method: "GET",
      url: `/admin/complaints/${filed.json().id}/recording`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown complaint", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/admin/complaints/does-not-exist/recording",
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s when no recording exists yet for the room", async () => {
    const { app } = setup();
    const filed = await fileComplaint(app);
    const res = await app.inject({
      method: "GET",
      url: `/admin/complaints/${filed.json().id}/recording`,
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a playback url when one exists", async () => {
    const { app, recordingProvider } = setup();
    const filed = await fileComplaint(app);
    recordingProvider.accessLinksByRoom.set(PROVIDER_ROOM_ID, "https://daily.example/recordings/abc123");

    const res = await app.inject({
      method: "GET",
      url: `/admin/complaints/${filed.json().id}/recording`,
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://daily.example/recordings/abc123" });
  });

  it("502s (not a raw error) when the recording provider throws", async () => {
    const { app, recordingProvider } = setup();
    const filed = await fileComplaint(app);
    recordingProvider.getAccessLinkForRoom = async () => {
      throw new Error("daily list recordings failed: 500 secret-key-xyz");
    };

    const res = await app.inject({
      method: "GET",
      url: `/admin/complaints/${filed.json().id}/recording`,
      headers: { "x-user-id": "admin", "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(502);
  });
});

describe("log level management", () => {
  it("rejects without a valid internal token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/internal/log-level" });
    expect(res.statusCode).toBe(401);
  });

  it("reads and changes the runtime log level, then resets it", async () => {
    const { app } = setup();
    const get = await app.inject({ method: "GET", url: "/internal/log-level", headers: { "x-internal-service-token": INTERNAL_TOKEN } });
    expect(get.json().level).toBe("info");

    const set = await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { level: "debug" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().level).toBe("debug");

    await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { level: "info" },
    });
  });

  it("rejects an unrecognized level", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { level: "verbose" },
    });
    expect(res.statusCode).toBe(400);
  });
});
