import { Pool } from "pg";
import {
  Complaint,
  ComplaintOutcome,
  ComplaintsRepository,
  CreateComplaintInput,
  DuplicateComplaintError,
} from "./complaints-repository.js";

const UNIQUE_VIOLATION = "23505";

interface ComplaintRow {
  id: string;
  booking_id: string;
  complainant_user_id: string;
  reason: string;
  status: "open" | "resolved";
  outcome: ComplaintOutcome | null;
  created_at: string;
  resolved_at: string | null;
}

function toComplaint(row: ComplaintRow): Complaint {
  return {
    id: row.id,
    bookingId: row.booking_id,
    complainantUserId: row.complainant_user_id,
    reason: row.reason,
    status: row.status,
    outcome: row.outcome,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class PostgresComplaintsRepository implements ComplaintsRepository {
  constructor(private readonly pool: Pool) {}

  async createComplaint(input: CreateComplaintInput): Promise<Complaint> {
    try {
      const { rows } = await this.pool.query<ComplaintRow>(
        `INSERT INTO complaints (booking_id, complainant_user_id, reason) VALUES ($1, $2, $3) RETURNING *`,
        [input.bookingId, input.complainantUserId, input.reason],
      );
      return toComplaint(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateComplaintError(input.bookingId);
      }
      throw err;
    }
  }

  async getByBookingId(bookingId: string): Promise<Complaint | null> {
    const { rows } = await this.pool.query<ComplaintRow>("SELECT * FROM complaints WHERE booking_id = $1", [bookingId]);
    return rows[0] ? toComplaint(rows[0]) : null;
  }

  async getById(id: string): Promise<Complaint | null> {
    const { rows } = await this.pool.query<ComplaintRow>("SELECT * FROM complaints WHERE id = $1", [id]);
    return rows[0] ? toComplaint(rows[0]) : null;
  }

  async resolve(id: string, outcome: ComplaintOutcome): Promise<Complaint | null> {
    const { rows } = await this.pool.query<ComplaintRow>(
      `UPDATE complaints SET status = 'resolved', outcome = $2, resolved_at = now() WHERE id = $1 RETURNING *`,
      [id, outcome],
    );
    return rows[0] ? toComplaint(rows[0]) : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === UNIQUE_VIOLATION;
}
