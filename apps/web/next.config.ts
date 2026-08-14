import type { NextConfig } from "next";

/**
 * Structural directives only. `script-src`, `img-src`, and `media-src` are
 * deliberately absent: posters and playback come from presigned URLs on the
 * deployment's own object store, whose origin is a runtime setting, while
 * `headers()` is baked into the routes manifest at build time. Naming an origin
 * here would break playback on every deployment that configured a different
 * one. Script injection is already contained by React's escaping — the tree
 * contains no `dangerouslySetInnerHTML` — so the directives below add the
 * protections that do not depend on where media lives.
 */
const contentSecurityPolicy = [
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  // No page in this app is meant to be framed; embedding is served by the
  // playback API, which authorizes callers on their Origin header instead.
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The recorder needs these on Cap's own origin; nothing else may ask for them.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), display-capture=(self)",
  },
];

// Browsers ignore HSTS over plaintext, but sending it only in production keeps
// a http:// LAN deployment from being pinned to https:// during development.
if (process.env.NODE_ENV === "production")
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cap/domain", "@cap/recording"],
  output: "standalone",
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
};

export default nextConfig;
