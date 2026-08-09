import { ZodError } from "zod";
import {
  assertEmbedOrigin,
  authorizeEmbedPlayback,
  embedError,
  EmbedServiceError,
} from "../../../../../lib/embeds/service";
import { embedPlaybackSchema } from "../../../../../lib/embeds/validation";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";
import { AnalyticsServiceError } from "../../../../../lib/analytics/service";
import { ShareRateLimitError } from "../../../../../lib/sharing/rate-limit";
import { SharingServiceError } from "../../../../../lib/sharing/service";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const input = embedPlaybackSchema.parse(
      await request.json().catch(() => ({})),
    );
    const { origin, playback } = await authorizeEmbedPlayback(
      request,
      recordingId,
      input,
    );
    return Response.json(playback, {
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "cache-control": "private, no-store",
        vary: "Origin",
      },
    });
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
        { status: 429 },
      );
    if (
      error instanceof EmbedServiceError ||
      error instanceof SharingServiceError
    )
      return embedError(error);
    console.error("embed playback failed", error);
    return Response.json(
      { error: { code: "EMBED_PLAYBACK_FAILED" } },
      { status: 500 },
    );
  }
}

export async function OPTIONS(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const origin = await assertEmbedOrigin(
      recordingId,
      request.headers.get("origin"),
    );
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  } catch (error) {
    if (error instanceof EmbedServiceError) return embedError(error);
    return new Response(null, { status: 403 });
  }
}
