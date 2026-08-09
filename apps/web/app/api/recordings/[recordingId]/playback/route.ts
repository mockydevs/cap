import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import {
  actorFromToken,
  tokenFromRequest,
} from "../../../../../lib/auth/session";
import { sharingError } from "../../../../../lib/sharing/http";
import { authorizeRecordingPlayback } from "../../../../../lib/sharing/service";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const actor = await actorFromToken(tokenFromRequest(request));
    return Response.json(await authorizeRecordingPlayback(recordingId, actor), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return sharingError(error);
  }
}
