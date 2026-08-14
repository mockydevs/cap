import { isIP } from "node:net";

/**
 * Used when the caller's address cannot be established. Callers key rate limits
 * on it, so unattributable traffic shares one bucket rather than escaping the
 * limit entirely.
 */
export const UNKNOWN_ADDRESS = "unknown";

/** One reverse proxy (Traefik, in the documented Coolify topology). */
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

function trustedProxyHops(): number {
  const configured = Number(process.env.TRUSTED_PROXY_HOP_COUNT);
  return Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_TRUSTED_PROXY_HOPS;
}

/**
 * Accepts the four shapes a proxy may write: a bare address, `ipv4:port`, and
 * either bracketed IPv6 form.
 */
function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1];
  // One colon marks an IPv4 `host:port`; a bare IPv6 address always has more.
  const parts = trimmed.split(":");
  const candidate = bracketed ?? (parts.length === 2 ? parts[0]! : trimmed);
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

/**
 * The caller's address, taken from `x-forwarded-for` counting back from the
 * right by the number of proxies in front of the app.
 *
 * Every proxy appends the peer it accepted the connection from, so the entries
 * a client can write are always to the left of the ones the trusted proxies
 * added. Reading a fixed number of hops from the right is therefore the only
 * part of the header a caller cannot forge — trusting `x-real-ip`, or the
 * leftmost entry, lets anyone mint a fresh rate-limit bucket per request.
 *
 * This is safe only while the app is unreachable except through those proxies.
 * See docs/OPERATIONS.md.
 */
export function clientAddress(request: Request): string {
  const hops = trustedProxyHops();
  if (hops === 0) return UNKNOWN_ADDRESS;

  const entries = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // A chain shorter than configured means the request did not traverse the
  // expected proxies, so nothing in it is trustworthy.
  if (entries.length < hops) return UNKNOWN_ADDRESS;

  return normalizeAddress(entries[entries.length - hops]!) ?? UNKNOWN_ADDRESS;
}
