// Chromium-only auth helpers backing the popup's sign-in/sign-out flows and
// the background service worker's defensive auth checks. Tokens are stored
// in chrome.storage.local (never .sync — access tokens must not roam to a
// user's other signed-in browsers via Chrome Sync) keyed by server origin so
// a user can hold separate sessions against, e.g., a local dev server and a
// production Cap server without either clobbering the other.

/**
 * @param {string} serverOrigin
 * @param {string} email
 * @param {string} password
 */
export async function login(serverOrigin, email, password) {
  const response = await fetch(`${serverOrigin}/api/desktop/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok)
    // Mirror the Tauri desktop client: never leak server error bodies to the
    // popup, just a generic invalid-credentials message.
    throw new Error("Invalid email or password");
  const json = await response.json();
  await storeToken(serverOrigin, { token: json.token, email: json.user.email });
  return json;
}

/**
 * @param {string} serverOrigin
 * @param {{token: string, email: string}} credentials
 */
export async function storeToken(serverOrigin, { token, email }) {
  const stored = await chrome.storage.local.get("auth");
  const auth = stored.auth ?? {};
  await chrome.storage.local.set({
    auth: { ...auth, [serverOrigin]: { token, email } },
  });
}

/**
 * @param {string} serverOrigin
 * @returns {Promise<{token: string, email: string} | null>}
 */
export async function getToken(serverOrigin) {
  const stored = await chrome.storage.local.get("auth");
  return stored.auth?.[serverOrigin] ?? null;
}

/**
 * @param {string} serverOrigin
 */
export async function clearToken(serverOrigin) {
  const stored = await chrome.storage.local.get("auth");
  const auth = { ...(stored.auth ?? {}) };
  delete auth[serverOrigin];
  await chrome.storage.local.set({ auth });
}

/**
 * Best-effort server-side session revocation. Always clears the local token
 * afterwards regardless of whether the network call succeeded, so signing
 * out never gets stuck because the server is unreachable.
 * @param {string} serverOrigin
 */
export async function logout(serverOrigin) {
  try {
    const existing = await getToken(serverOrigin);
    if (existing?.token) {
      await fetch(`${serverOrigin}/api/desktop/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${existing.token}` },
      });
    }
  } catch {
    // Network failures must never block local sign-out.
  }
  await clearToken(serverOrigin);
}

/**
 * Requests the optional host permission needed to fetch/upload against the
 * given server origin. MUST be called from a page with an active user
 * gesture (e.g. a popup button click) — chrome.permissions.request() throws
 * when called from a background service worker or without a user gesture.
 * @param {string} serverOrigin
 * @returns {Promise<boolean>} the final granted state
 */
export async function ensureHostPermission(serverOrigin) {
  const origin = `${serverOrigin}/*`;
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  return chrome.permissions.request({ origins: [origin] });
}
