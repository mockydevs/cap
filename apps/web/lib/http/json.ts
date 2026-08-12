/**
 * Browser-side calls into Cap's own API. Every route speaks JSON and every
 * workspace panel must read live state rather than a cached copy, so the
 * content type and cache policy live here instead of at each call site.
 *
 * Both helpers hand back the raw Response: callers own their error copy and
 * status handling, which differs per panel.
 */

export type JsonMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Sends a JSON body (omit `body` for verbs that carry none). Mutations are
 * never served from a cache, so the result always reflects the write.
 */
export function sendJson(
  url: string,
  method: JsonMethod,
  body?: unknown,
): Promise<Response> {
  return fetch(url, {
    method,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

/** Reads an endpoint, bypassing any cached response. */
export function fetchFresh(url: string): Promise<Response> {
  return fetch(url, { cache: "no-store" });
}
