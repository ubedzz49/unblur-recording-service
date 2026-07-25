-- Shares the same RDS instance and database as the other unblur services (pragmatic reuse of
-- existing infra) -- this service owns and only touches the complaints table. Recordings
-- themselves are never persisted here -- Daily.co is the source of truth for what recordings
-- exist, and the retention sweep queries Daily's own API directly rather than mirroring state.
CREATE TABLE IF NOT EXISTS complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- soft reference to resolution-service's bookings.id -- same physical DB, different service's
  -- table, so no cross-db FK here, same pattern as payments.reference_id
  booking_id UUID NOT NULL,
  -- soft reference to user-service's users.id -- only the booking's poster may file a complaint
  complainant_user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  -- set only once status = 'resolved' -- decides whether the held payout ultimately releases
  -- (dismissed) or stays withheld (upheld). Resolved manually via an internal endpoint for now,
  -- there's no admin UI until Version 9.
  outcome TEXT NULL CHECK (outcome IN ('upheld', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  -- one complaint per booking -- a poster reporting the same session twice should see their
  -- existing complaint, not create a second one
  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS idx_complaints_booking ON complaints (booking_id);
