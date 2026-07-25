export interface BookingSummary {
  id: string;
  posterUserId: string;
  resolverUserId: string;
  status: string;
  providerRoomId: string | null;
}

// used only to verify a complaint is being filed by the booking's actual poster -- forwards the
// caller's own X-User-Id rather than the internal service token, since Resolution Service's
// GET /bookings/:id is itself a user-facing (not internal) route
export interface BookingClient {
  getBooking(bookingId: string, callerUserId: string): Promise<BookingSummary | null>;
  // admin-only -- looks up a booking regardless of who posted/resolved it, for the admin
  // dashboard's "view this complaint's recording" action
  getBookingAsAdmin(bookingId: string): Promise<BookingSummary | null>;
}

const REQUEST_TIMEOUT_MS = 2000;

export class HttpBookingClient implements BookingClient {
  constructor(private readonly baseUrl: string | undefined = process.env.RESOLUTION_SERVICE_URL) {}

  async getBooking(bookingId: string, callerUserId: string): Promise<BookingSummary | null> {
    return this.fetchBooking(bookingId, { "x-user-id": callerUserId });
  }

  async getBookingAsAdmin(bookingId: string): Promise<BookingSummary | null> {
    return this.fetchBooking(bookingId, { "x-user-id": "admin", "x-user-role": "admin" });
  }

  private async fetchBooking(bookingId: string, headers: Record<string, string>): Promise<BookingSummary | null> {
    if (!this.baseUrl) {
      throw new Error("RESOLUTION_SERVICE_URL is not configured");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/bookings/${bookingId}`, {
        headers,
        signal: controller.signal,
      });
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) {
        throw new Error(`resolution service returned ${res.status} fetching booking`);
      }
      return (await res.json()) as BookingSummary;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeBookingClient implements BookingClient {
  private bookings = new Map<string, BookingSummary>();

  seed(booking: BookingSummary): void {
    this.bookings.set(booking.id, booking);
  }

  async getBooking(bookingId: string, callerUserId: string): Promise<BookingSummary | null> {
    const booking = this.bookings.get(bookingId);
    if (!booking) return null;
    // mirrors resolution-service's own ownership check -- a caller uninvolved in the booking
    // gets the same "not found" treatment a real 403 collapses to here
    if (booking.posterUserId !== callerUserId && booking.resolverUserId !== callerUserId) return null;
    return booking;
  }

  async getBookingAsAdmin(bookingId: string): Promise<BookingSummary | null> {
    return this.bookings.get(bookingId) ?? null;
  }
}
