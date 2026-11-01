-- Calari user IDs are opaque strings (cuid), not UUIDs.
ALTER TABLE cap_web_sessions ALTER COLUMN calari_user_id TYPE text;
