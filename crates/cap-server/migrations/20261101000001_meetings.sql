-- Meeting pipeline tables owned by the Rust server. Additive only: no
-- existing Cap table is changed. Ledger: sqlx's _sqlx_migrations table,
-- separate from Drizzle's, so the TypeScript migrations are unaffected.

CREATE TABLE meeting_request_nonces (
  key_id text NOT NULL,
  nonce text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX meeting_request_nonces_seen_idx ON meeting_request_nonces (seen_at);

CREATE TABLE meeting_pairings (
  id uuid PRIMARY KEY,
  key_id text NOT NULL,
  request_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  tenant_id text NOT NULL,
  pairing_kind text NOT NULL CHECK (pairing_kind IN ('client_intake', 'staff_client', 'internal_team')),
  client_id uuid,
  intake_receipt_id uuid,
  client_display_name text,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_id, request_id),
  CHECK ((pairing_kind = 'internal_team') = (client_id IS NULL)),
  CHECK (pairing_kind <> 'client_intake' OR intake_receipt_id IS NOT NULL)
);

CREATE TABLE meeting_devices (
  token_hash text PRIMARY KEY,
  pairing_id uuid NOT NULL REFERENCES meeting_pairings (id),
  device_name text NOT NULL,
  device_kind text NOT NULL CHECK (device_kind IN ('desktop', 'extension')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_redeem_failures (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_redeem_failures_source_idx ON meeting_redeem_failures (source, at);
CREATE INDEX meeting_redeem_failures_at_idx ON meeting_redeem_failures (at);

CREATE TABLE meeting_sessions (
  id uuid PRIMARY KEY,
  pairing_id uuid NOT NULL REFERENCES meeting_pairings (id),
  device_token_hash text NOT NULL REFERENCES meeting_devices (token_hash),
  idempotency_key text NOT NULL,
  title text NOT NULL,
  capture_mode text NOT NULL CHECK (capture_mode IN ('audio', 'video')),
  provider_hint text,
  meeting_url text,
  source text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  stop_reason text,
  last_seq integer,
  partial boolean NOT NULL DEFAULT false,
  state text NOT NULL,
  failure text,
  revision integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_upload_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_token_hash, idempotency_key)
);
CREATE INDEX meeting_sessions_work_idx ON meeting_sessions (state, next_attempt_at);

CREATE TABLE meeting_chunks (
  meeting_id uuid NOT NULL REFERENCES meeting_sessions (id),
  seq integer NOT NULL CHECK (seq >= 0),
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  container text NOT NULL,
  object_key text NOT NULL,
  start_ms bigint NOT NULL,
  duration_ms bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, seq)
);

CREATE TABLE meeting_events (
  id bigserial PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meeting_sessions (id),
  kind text NOT NULL,
  at timestamptz NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per chunk already transcribed, so a retry never pays twice.
CREATE TABLE meeting_chunk_transcripts (
  meeting_id uuid NOT NULL REFERENCES meeting_sessions (id),
  seq integer NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  language text,
  segments jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, seq)
);

CREATE TABLE meeting_transcripts (
  meeting_id uuid PRIMARY KEY REFERENCES meeting_sessions (id),
  provider text NOT NULL,
  model text NOT NULL,
  language text,
  segments jsonb NOT NULL,
  text text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_deliveries (
  event_id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meeting_sessions (id),
  revision integer NOT NULL,
  key_id text NOT NULL,
  delivery_url text NOT NULL,
  body bytea NOT NULL,
  body_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  receipt_id text,
  ack_status text,
  last_status_code integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, revision)
);

CREATE TABLE meeting_delivery_attempts (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES meeting_deliveries (event_id),
  at timestamptz NOT NULL DEFAULT now(),
  status_code integer,
  error text
);
