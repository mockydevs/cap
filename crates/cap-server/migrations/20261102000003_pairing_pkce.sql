-- PKCE binding for pairings created by the extension's "Sign in with Calari"
-- flow: such a pairing only redeems with the matching code_verifier.
ALTER TABLE meeting_pairings ADD COLUMN pkce_challenge text;
