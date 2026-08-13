import { describe, expect, it } from "vitest";
import {
  CHECKSUM_HEADER,
  describeCorsVerdict,
  evaluatePreflight,
  requiredCorsRule,
  verifyBucketCors,
} from "../src/cors";

const ORIGIN = "https://cap.example.com";

const allowing = (overrides: Record<string, string | null> = {}) => ({
  status: 200,
  origin: ORIGIN,
  headers: {
    allowOrigin: ORIGIN,
    allowMethods: "PUT, GET, HEAD",
    allowHeaders: `content-type, ${CHECKSUM_HEADER}`,
    exposeHeaders: `ETag, ${CHECKSUM_HEADER}`,
    ...overrides,
  },
});

describe("bucket CORS verdicts", () => {
  it("accepts a correctly configured bucket", () => {
    const verdict = evaluatePreflight(allowing());
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it("reads a rejected preflight as a missing configuration", () => {
    // What the production bucket actually returned: 403 AccessForbidden.
    const verdict = evaluatePreflight({ ...allowing(), status: 403 });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(["PREFLIGHT_REJECTED"]);
    expect(verdict.detail).toContain("no CORS configuration");
  });

  it("catches the exposed-ETag omission that lets uploads start but never finish", () => {
    const verdict = evaluatePreflight(
      allowing({ exposeHeaders: CHECKSUM_HEADER }),
    );
    expect(verdict.problems).toEqual(["ETAG_NOT_EXPOSED"]);
    expect(verdict.detail).toContain("never be completed");
  });

  it("catches a bucket that allows a different origin", () => {
    const verdict = evaluatePreflight(
      allowing({ allowOrigin: "https://other.example.com" }),
    );
    expect(verdict.problems).toContain("ORIGIN_NOT_ALLOWED");
  });

  it("catches a bucket that does not permit PUT", () => {
    const verdict = evaluatePreflight(allowing({ allowMethods: "GET, HEAD" }));
    expect(verdict.problems).toContain("METHOD_NOT_ALLOWED");
  });

  it("catches a bucket that strips the checksum header", () => {
    const verdict = evaluatePreflight(
      allowing({ allowHeaders: "content-type" }),
    );
    expect(verdict.problems).toContain("CHECKSUM_HEADER_NOT_ALLOWED");
  });

  it("accepts wildcards, which some providers answer with", () => {
    const verdict = evaluatePreflight(
      allowing({ allowOrigin: "*", allowHeaders: "*", exposeHeaders: "*" }),
    );
    expect(verdict.ok).toBe(true);
  });

  it("reports several problems at once rather than only the first", () => {
    const verdict = evaluatePreflight(
      allowing({ allowMethods: "GET", exposeHeaders: "" }),
    );
    expect(verdict.problems).toEqual([
      "METHOD_NOT_ALLOWED",
      "ETAG_NOT_EXPOSED",
    ]);
  });
});

describe("the rule Cap publishes", () => {
  it("is the one its own checker accepts", () => {
    const rule = requiredCorsRule([ORIGIN]);
    const verdict = evaluatePreflight({
      status: 200,
      origin: ORIGIN,
      headers: {
        allowOrigin: rule.AllowedOrigins[0]!,
        allowMethods: rule.AllowedMethods.join(", "),
        allowHeaders: rule.AllowedHeaders.join(", "),
        exposeHeaders: rule.ExposeHeaders.join(", "),
      },
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("verifyBucketCors", () => {
  it("sends the preflight a browser would send", async () => {
    let seen: Request | undefined;
    await verifyBucketCors({
      bucketUrl: "https://bucket.example.com/",
      origin: ORIGIN,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = new Request(url, init);
        return new Response(null, { status: 200, headers: {} });
      }) as unknown as typeof fetch,
    });
    expect(seen?.method).toBe("OPTIONS");
    expect(seen?.headers.get("origin")).toBe(ORIGIN);
    expect(seen?.headers.get("access-control-request-method")).toBe("PUT");
  });

  it("reports an unreachable bucket instead of throwing", async () => {
    const verdict = await verifyBucketCors({
      bucketUrl: "https://bucket.example.com/",
      origin: ORIGIN,
      fetchImpl: (() =>
        Promise.reject(
          new TypeError("network down"),
        )) as unknown as typeof fetch,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("Could not reach the bucket");
  });
});

describe("describeCorsVerdict", () => {
  it("says plainly when everything is in order", () => {
    expect(
      describeCorsVerdict({ ok: true, problems: [], detail: "" }),
    ).toContain("allows browser uploads");
  });
});
