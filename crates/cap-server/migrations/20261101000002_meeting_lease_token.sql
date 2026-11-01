-- Fencing token for the worker lease: every write a worker makes while
-- processing a meeting must still match the token it claimed with.
ALTER TABLE meeting_sessions ADD COLUMN lease_token uuid;
