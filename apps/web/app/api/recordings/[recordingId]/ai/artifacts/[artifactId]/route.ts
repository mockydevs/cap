import { requireActor } from "../../../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../../../lib/auth/origin";
import { aiError } from "../../../../../../../lib/ai/http";
import { decideArtifact } from "../../../../../../../lib/ai/service";
import { artifactDecisionSchema } from "../../../../../../../lib/ai/validation";
export const runtime = "nodejs";
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ recordingId: string; artifactId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const input = artifactDecisionSchema.parse(await request.json()),
      values = await params;
    return Response.json(
      await decideArtifact(
        values.recordingId,
        values.artifactId,
        await requireActor(request, "MEMBER"),
        input.status,
      ),
    );
  } catch (error) {
    return aiError(error);
  }
}
