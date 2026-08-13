/**
 * Browser uploads go straight to object storage, so the bucket — not the web
 * app — decides whether they are allowed. A bucket with no CORS rule rejects
 * the preflight, `fetch` throws a bare TypeError, and the person recording
 * sees "Failed to fetch" with nothing pointing at the cause. That happened in
 * production and cost an afternoon to trace.
 *
 * This module makes the requirement explicit and checkable: one definition of
 * the rule a Cap bucket needs, and a check that reports precisely which part
 * is missing.
 */

/** Header carrying the per-part digest, bound into the presigned request. */
export const CHECKSUM_HEADER = "x-amz-checksum-sha256";

/**
 * Headers the browser sends on a part upload. `authorization`, `x-amz-date`
 * and `x-amz-security-token` appear when a request is signed with temporary
 * credentials rather than query parameters.
 */
export const REQUIRED_REQUEST_HEADERS = [
  "content-type",
  "content-length",
  CHECKSUM_HEADER,
  "x-amz-content-sha256",
  "x-amz-date",
  "authorization",
  "x-amz-security-token",
] as const;

/**
 * Headers the browser must be able to *read* back. ETag is the one that gets
 * missed: without it the upload succeeds and then cannot be completed, because
 * the client has no part identifier to send.
 */
export const REQUIRED_EXPOSED_HEADERS = ["ETag", CHECKSUM_HEADER] as const;

export const REQUIRED_METHODS = ["PUT", "GET", "HEAD"] as const;

/** The rule a Cap bucket needs, in the shape S3 and R2 both accept. */
export function requiredCorsRule(origins: readonly string[]) {
  return {
    AllowedOrigins: [...origins],
    AllowedMethods: [...REQUIRED_METHODS],
    AllowedHeaders: [...REQUIRED_REQUEST_HEADERS],
    ExposeHeaders: [...REQUIRED_EXPOSED_HEADERS],
    MaxAgeSeconds: 600,
  };
}

export type CorsProblem =
  | "PREFLIGHT_REJECTED"
  | "ORIGIN_NOT_ALLOWED"
  | "METHOD_NOT_ALLOWED"
  | "CHECKSUM_HEADER_NOT_ALLOWED"
  | "ETAG_NOT_EXPOSED";

export interface CorsVerdict {
  readonly ok: boolean;
  readonly problems: readonly CorsProblem[];
  readonly detail: string;
}

const EXPLANATIONS: Readonly<Record<CorsProblem, string>> = {
  PREFLIGHT_REJECTED:
    "the bucket rejected the preflight outright, which usually means it has no CORS configuration at all",
  ORIGIN_NOT_ALLOWED: "the application origin is not in AllowedOrigins",
  METHOD_NOT_ALLOWED: "PUT is not in AllowedMethods, so parts cannot be sent",
  CHECKSUM_HEADER_NOT_ALLOWED: `${CHECKSUM_HEADER} is not in AllowedHeaders, so signed part uploads are blocked`,
  ETAG_NOT_EXPOSED:
    "ETag is not in ExposeHeaders, so uploads succeed but can never be completed",
};

/** Turns a verdict into something an operator can act on without guesswork. */
export function describeCorsVerdict(verdict: CorsVerdict): string {
  if (verdict.ok) return "Bucket CORS allows browser uploads.";
  return `Bucket CORS will not allow browser uploads: ${verdict.problems
    .map((problem) => EXPLANATIONS[problem])
    .join("; ")}.`;
}

/**
 * Judges a preflight response. Kept separate from the request so the rules can
 * be tested without a network or a bucket.
 */
export function evaluatePreflight(input: {
  readonly status: number;
  readonly headers: {
    readonly allowOrigin?: string | null;
    readonly allowMethods?: string | null;
    readonly allowHeaders?: string | null;
    readonly exposeHeaders?: string | null;
  };
  readonly origin: string;
}): CorsVerdict {
  const problems: CorsProblem[] = [];
  // S3 answers a disallowed preflight with 403 AccessForbidden rather than a
  // 200 carrying no CORS headers, so a non-2xx is itself the diagnosis.
  if (input.status < 200 || input.status >= 300) {
    const verdict = {
      ok: false,
      problems: ["PREFLIGHT_REJECTED" as const],
      detail: `preflight returned HTTP ${input.status}`,
    };
    return { ...verdict, detail: describeCorsVerdict(verdict) };
  }

  const allowOrigin = input.headers.allowOrigin?.trim();
  if (allowOrigin !== "*" && allowOrigin !== input.origin)
    problems.push("ORIGIN_NOT_ALLOWED");

  const list = (value: string | null | undefined) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

  const methods = list(input.headers.allowMethods);
  if (methods.length && !methods.includes("put"))
    problems.push("METHOD_NOT_ALLOWED");

  const allowed = list(input.headers.allowHeaders);
  if (
    allowed.length &&
    !allowed.includes("*") &&
    !allowed.includes(CHECKSUM_HEADER)
  )
    problems.push("CHECKSUM_HEADER_NOT_ALLOWED");

  const exposed = list(input.headers.exposeHeaders);
  if (!exposed.includes("*") && !exposed.includes("etag"))
    problems.push("ETAG_NOT_EXPOSED");

  const verdict = { ok: problems.length === 0, problems, detail: "" };
  return { ...verdict, detail: describeCorsVerdict(verdict) };
}

/**
 * Sends a real preflight, exactly as a browser would before a part upload.
 * Unauthenticated by nature — CORS is evaluated before credentials.
 */
export async function verifyBucketCors(input: {
  readonly bucketUrl: string;
  readonly origin: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<CorsVerdict> {
  const send = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(input.bucketUrl, {
      method: "OPTIONS",
      headers: {
        origin: input.origin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": CHECKSUM_HEADER,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const verdict = {
      ok: false,
      problems: ["PREFLIGHT_REJECTED" as const],
      detail: "",
    };
    return {
      ...verdict,
      detail: `Could not reach the bucket to check CORS: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
  return evaluatePreflight({
    status: response.status,
    origin: input.origin,
    headers: {
      allowOrigin: response.headers.get("access-control-allow-origin"),
      allowMethods: response.headers.get("access-control-allow-methods"),
      allowHeaders: response.headers.get("access-control-allow-headers"),
      exposeHeaders: response.headers.get("access-control-expose-headers"),
    },
  });
}
