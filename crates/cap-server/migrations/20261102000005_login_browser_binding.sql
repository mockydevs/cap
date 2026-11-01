-- Bind each sign-in attempt to the browser that started it (an HttpOnly
-- cookie), so a callback link handed to someone else cannot sign them in.
ALTER TABLE cap_login_attempts ADD COLUMN browser_hash text;
