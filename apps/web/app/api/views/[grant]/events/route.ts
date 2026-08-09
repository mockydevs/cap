import { ZodError } from "zod";
import {
  AnalyticsServiceError,
  recordViewEvent,
} from "../../../../../lib/analytics/service";
import {
  viewEventSchema,
  viewGrantParamsSchema,
} from "../../../../../lib/analytics/validation";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { ShareRateLimitError } from "../../../../../lib/sharing/rate-limit";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ grant: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const { grant } = viewGrantParamsSchema.parse(await context.params);
    const event = viewEventSchema.parse(await request.json());
    await recordViewEvent(grant, event);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ZodError)
      return Response.json(
        { error: { code: "VALIDATION_ERROR" } },
        { status: 400 },
      );
    if (error instanceof AnalyticsServiceError)
      return Response.json(
        { error: { code: error.code } },
        { status: error.status },
      );
    if (error instanceof ShareRateLimitError)
      return Response.json(
        { error: { code: "RATE_LIMITED" } },
        { status: 429, headers: { "retry-after": "60" } },
      );
    console.error("view event request failed", error);
    return Response.json(
      { error: { code: "VIEW_EVENT_FAILED" } },
      { status: 500 },
    );
  }
}
