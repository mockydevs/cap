-- Calendar attendance: per-staff Google Calendar connections, synced events
-- and the durable attendance schedule. Additive only.

-- The server issues calendar bot devices itself (never via public redeem).
ALTER TABLE meeting_devices DROP CONSTRAINT IF EXISTS meeting_devices_device_kind_check;
ALTER TABLE meeting_devices ADD CONSTRAINT meeting_devices_device_kind_check
  CHECK (device_kind IN ('desktop', 'extension', 'calendar_bot'));

-- One-time Google OAuth attempts, bound to the Cap web session that began
-- them (and therefore to one Calari staff member) and to a browser cookie.
CREATE TABLE calendar_oauth_attempts (
  state_hash text PRIMARY KEY,
  session_hash text NOT NULL,
  browser_hash text NOT NULL,
  tenant_id text NOT NULL,
  calari_user_id text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_oauth_attempts_expiry_idx ON calendar_oauth_attempts (expires_at);

CREATE TABLE calendar_connections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  calari_user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google')),
  account_email text NOT NULL,
  -- AEAD(refresh token), associated data binds it to this row's owner.
  refresh_ciphertext bytea,
  key_id text,
  scopes text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'needs_reconnect', 'revoked')),
  auto_join boolean NOT NULL DEFAULT true,
  -- Incremental sync: sync_token is advanced only after every page of a run
  -- is reconciled; page_token is the durable cursor inside a run.
  sync_token text,
  page_token text,
  sync_run_token text,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  sync_lease_token uuid,
  sync_lease_until timestamptz,
  sync_attempts integer NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, calari_user_id, provider)
);
CREATE INDEX calendar_connections_sync_idx ON calendar_connections (status, next_sync_at);

CREATE TABLE calendar_attendances (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  -- The staff member whose grant created it; Calari pairs as this person.
  owner_connection_id uuid NOT NULL REFERENCES calendar_connections (id),
  meet_code text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  title text NOT NULL,
  -- Routing: 'client' with client_id, 'internal', or 'needs_review'.
  routing text NOT NULL CHECK (routing IN ('client', 'internal', 'needs_review')),
  client_id uuid,
  state text NOT NULL CHECK (state IN (
    'scheduled', 'preparing', 'ready', 'claimed', 'joining', 'waiting',
    'recording', 'completed', 'cancelled', 'failed', 'needs_review')),
  -- Bumped on every reschedule; a pairing request id is derived from it.
  version integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  pairing_id text,
  device_token_hash text,
  device_token_ciphertext bytea,
  meeting_id uuid REFERENCES meeting_sessions (id),
  failure text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((routing = 'client') = (client_id IS NOT NULL))
);
-- One bot per tenant, meeting and start time while it is live.
CREATE UNIQUE INDEX calendar_attendances_dedupe_idx
  ON calendar_attendances (tenant_id, meet_code, starts_at)
  WHERE state NOT IN ('cancelled', 'failed', 'completed');
CREATE INDEX calendar_attendances_work_idx ON calendar_attendances (state, next_attempt_at);

CREATE TABLE calendar_events (
  connection_id uuid NOT NULL REFERENCES calendar_connections (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  meet_code text,
  attendee_emails jsonb NOT NULL DEFAULT '[]',
  self_declined boolean NOT NULL DEFAULT false,
  -- Organiser, or accepted the invite. Unanswered invites never schedule.
  self_accepted boolean NOT NULL DEFAULT false,
  google_updated timestamptz,
  -- Staff choice for this event: 'auto', 'internal', 'skip' or 'client'.
  choice text NOT NULL DEFAULT 'auto' CHECK (choice IN ('auto', 'internal', 'skip', 'client')),
  choice_client_id uuid,
  attendance_id uuid REFERENCES calendar_attendances (id),
  -- Clients Calari mapped from these attendees: [{client_id, name}].
  candidates jsonb NOT NULL DEFAULT '[]',
  -- Full-sync run that last saw this event (deleted-while-offline detection).
  seen_run text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, event_id),
  CHECK ((choice = 'client') = (choice_client_id IS NOT NULL))
);
CREATE INDEX calendar_events_attendance_idx ON calendar_events (attendance_id);

-- Hash of the bot runner's bearer token is configured, not stored here.
CREATE TABLE calendar_attendance_log (
  id bigserial PRIMARY KEY,
  attendance_id uuid NOT NULL REFERENCES calendar_attendances (id),
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  detail text
);
