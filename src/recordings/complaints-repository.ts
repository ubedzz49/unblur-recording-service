export type ComplaintStatus = "open" | "resolved";
export type ComplaintOutcome = "upheld" | "dismissed";

export interface Complaint {
  id: string;
  bookingId: string;
  complainantUserId: string;
  reason: string;
  status: ComplaintStatus;
  outcome: ComplaintOutcome | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CreateComplaintInput {
  bookingId: string;
  complainantUserId: string;
  reason: string;
}

// thrown by createComplaint when the DB's unique index on booking_id rejects the write -- callers
// turn this into a clean 409 (or just return the existing complaint), never a raw DB error
export class DuplicateComplaintError extends Error {
  constructor(bookingId: string) {
    super(`booking ${bookingId} already has a complaint`);
    this.name = "DuplicateComplaintError";
  }
}

export interface ComplaintsRepository {
  createComplaint(input: CreateComplaintInput): Promise<Complaint>;
  getByBookingId(bookingId: string): Promise<Complaint | null>;
  getById(id: string): Promise<Complaint | null>;
  resolve(id: string, outcome: ComplaintOutcome): Promise<Complaint | null>;
  // admin-only
  listAll(status?: ComplaintStatus): Promise<Complaint[]>;
}

// test-only -- avoids CI needing real Postgres
export class InMemoryComplaintsRepository implements ComplaintsRepository {
  private complaints = new Map<string, Complaint>();
  private byBooking = new Map<string, string>();

  async createComplaint(input: CreateComplaintInput): Promise<Complaint> {
    if (this.byBooking.has(input.bookingId)) {
      throw new DuplicateComplaintError(input.bookingId);
    }
    const complaint: Complaint = {
      id: crypto.randomUUID(),
      bookingId: input.bookingId,
      complainantUserId: input.complainantUserId,
      reason: input.reason,
      status: "open",
      outcome: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.complaints.set(complaint.id, complaint);
    this.byBooking.set(input.bookingId, complaint.id);
    return complaint;
  }

  async getByBookingId(bookingId: string): Promise<Complaint | null> {
    const id = this.byBooking.get(bookingId);
    return id ? this.complaints.get(id)! : null;
  }

  async getById(id: string): Promise<Complaint | null> {
    return this.complaints.get(id) ?? null;
  }

  async resolve(id: string, outcome: ComplaintOutcome): Promise<Complaint | null> {
    const existing = this.complaints.get(id);
    if (!existing) return null;
    const updated: Complaint = { ...existing, status: "resolved", outcome, resolvedAt: new Date().toISOString() };
    this.complaints.set(id, updated);
    return updated;
  }

  async listAll(status?: ComplaintStatus): Promise<Complaint[]> {
    return Array.from(this.complaints.values())
      .filter((c) => (status ? c.status === status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
