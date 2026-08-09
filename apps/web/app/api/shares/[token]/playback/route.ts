import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { sharingError } from "../../../../../lib/sharing/http";
import { authorizeSharePlayback } from "../../../../../lib/sharing/service";
import {
  sharePlaybackSchema,
  shareTokenParamsSchema,
} from "../../../../../lib/sharing/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const { token } = shareTokenParamsSchema.parse(await context.params);
    const body = sharePlaybackSchema.parse(
      await request.json().catch(() => ({})),
    );
    return Response.json(
      await authorizeSharePlayback(request, token, body.password),
      {
        headers: { "cache-control": "private, no-store" },
      },
    );
  } catch (error) {
    return sharingError(error);
  }
}
