import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { sharingError } from "../../../../../lib/sharing/http";
import { authorizeSharePlayback } from "../../../../../lib/sharing/service";
import { shareTokenParamsSchema } from "../../../../../lib/sharing/validation";

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
    return Response.json(await authorizeSharePlayback(request, token), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return sharingError(error);
  }
}
