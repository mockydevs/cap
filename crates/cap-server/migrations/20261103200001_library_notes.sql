-- Meetings library: staff notes, display titles and archiving. Additive only.
-- The recorded meeting (title, transcript, audio, frozen Calari deliveries)
-- is never changed by the library; these tables sit beside it.

-- One row per meeting the library has touched. `version` starts at 0 and
-- goes up by one on every rename, archive or restore, so a stale form can be
-- detected instead of silently overwriting someone else's change.
CREATE TABLE library_meetings (
  meeting_id uuid PRIMARY KEY REFERENCES meeting_sessions (id),
  tenant_id text NOT NULL,
  display_title text CHECK (display_title IS NULL OR char_length(display_title) BETWEEN 1 AND 200),
  archived_at timestamptz,
  archived_by text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
CREATE INDEX library_meetings_tenant_idx ON library_meetings (tenant_id, archived_at);

-- Notes written by staff in the library. Never sent to Calari.
CREATE TABLE library_notes (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meeting_sessions (id),
  tenant_id text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  -- Random per form; a double-submitted form creates one note, not two.
  submit_key uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by text NOT NULL,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_by_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, submit_key)
);
CREATE INDEX library_notes_meeting_idx ON library_notes (meeting_id, created_at);

-- Who changed what and when. Never holds note text.
CREATE TABLE library_audit (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  meeting_id uuid NOT NULL REFERENCES meeting_sessions (id),
  note_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX library_audit_meeting_idx ON library_audit (meeting_id, at);
