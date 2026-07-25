# unblur-recording-service

Recording retention and post-session complaint handling for resolution bookings. Owns the
`complaints` table; recordings themselves are never mirrored here -- Daily.co's own recordings
API is the source of truth, queried directly by the retention sweep.

## Recording retention

Meeting Service enables Daily's cloud recording (`enable_recording: "cloud"`) when it creates a
room. This service runs a `setInterval`-based sweep (every 60s) that lists every recording via
Daily's `GET /v1/recordings` and deletes any older than `RECORDING_RETENTION_MINS` (default 15).
No separate cron/scheduler infra -- this is a long-running Fargate task like every other service
here, so a plain interval is enough at this retention window's scale.

## Complaints

- `POST /complaints` (user-facing, poster only, completed bookings only) -- files a complaint.
  Idempotent per booking: filing twice returns the existing complaint (200) instead of erroring.
  Verifies the caller is actually the booking's poster by calling Resolution Service's
  `GET /bookings/:id` with the caller's own `X-User-Id` forwarded.
- `GET /complaints/:bookingId` (user-facing) -- the complainant's own view of their complaint.
- `GET /internal/complaints/by-booking/:bookingId` (internal) -- used by Payment Service to
  decide whether a held payout can release once its hold window elapses.
- `POST /internal/complaints/:id/resolve` (internal, `{outcome: "upheld"|"dismissed"}`) -- there's
  no admin UI until Version 9, so a complaint is resolved via a direct internal API call by
  support for now, not through this app. Upheld keeps the payout withheld; dismissed lets it
  release on the next sweep.

## Auth

Same pattern as every other service here: `/internal/*` requires `X-Internal-Service-Token`
(fails to start if unset); everything else trusts the gateway-verified `X-User-Id` header.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Scripts

- `npm run dev` -- local dev server
- `npm run build` -- production build
- `npm run migrate` -- run pending migrations
- `npm test` -- unit tests (Vitest)
