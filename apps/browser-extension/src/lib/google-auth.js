// Chromium-only "Sign in with Google" flow, driven entirely by
// chrome.identity.launchWebAuthFlow (the "identity" permission).
//
// Deployment note: the real Google Cloud Console OAuth client referenced by
// the server's GOOGLE_DESKTOP_OAUTH_CLIENT_ID env var must have
// `https://<this-extension's-id>.chromiumapp.org/` registered as an
// authorized redirect URI. The extension ID differs between a Chrome Web
// Store-published build and a locally-loaded unpacked build, so this is a
// real, manual deployment step for each build/publish target — it cannot be
// self-configured from code.

import { storeToken } from "./auth.js";

/**
 * Base64url-encodes bytes with no padding, per RFC 4648 §5.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generates a nonce matching the server's `^[A-Za-z0-9_-]{43}$` regex: 32
 * random bytes, base64url-encoded with no padding, which is always exactly
 * 43 characters.
 * @returns {string}
 */
export function generateNonce() {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce))
    throw new Error("Generated nonce does not match the expected shape");
  return nonce;
}

/**
 * @param {string} clientId
 * @param {string} nonce
 * @returns {string}
 */
export function buildAuthUrl(clientId, nonce) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", chrome.identity.getRedirectURL());
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/**
 * Extracts the `id_token` fragment parameter from a launchWebAuthFlow
 * redirect URL.
 * @param {string} responseUrl
 * @returns {string | null}
 */
export function extractIdToken(responseUrl) {
  const hash = new URL(responseUrl).hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("id_token");
}

/**
 * @param {string} serverOrigin
 */
export async function signInWithGoogle(serverOrigin) {
  const configResponse = await fetch(
    `${serverOrigin}/api/desktop/auth/google/config`,
  );
  if (!configResponse.ok)
    throw new Error("Google sign-in is not configured on this server");
  const { clientId } = await configResponse.json();

  const nonce = generateNonce();
  const authUrl = buildAuthUrl(clientId, nonce);

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch {
    throw new Error("Google sign-in was canceled");
  }
  const idToken = responseUrl ? extractIdToken(responseUrl) : null;
  if (!idToken) throw new Error("Google sign-in did not return an ID token");

  const response = await fetch(`${serverOrigin}/api/desktop/auth/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken, nonce }),
  });
  if (!response.ok) throw new Error("Google sign-in failed");
  const json = await response.json();
  // The Google endpoint returns only a displayName, no email — store what's
  // actually available rather than inventing an email address.
  await storeToken(serverOrigin, { token: json.token, email: json.displayName });
  return json;
}
