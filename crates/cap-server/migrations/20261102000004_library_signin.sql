-- Meetings library sign-in through Calari. Cap keeps no passwords: a
-- session only remembers which Calari staff member signed in.
CREATE TABLE cap_login_attempts (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  key_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cap_web_sessions (
  token_hash text PRIMARY KEY,
  tenant_id text NOT NULL,
  calari_user_id uuid NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'staff')),
  -- Absolute expiry (8 h); idle expiry uses last_seen_at (1 h).
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- When Calari last confirmed this staff member is active (at most 60 s old
  -- before any library page or media is served).
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cap_web_sessions_expiry_idx ON cap_web_sessions (expires_at);
