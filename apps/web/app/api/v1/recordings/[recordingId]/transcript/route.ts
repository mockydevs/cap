import { requireApiKeyActor } from "../../../../../../lib/api-keys/auth";
import { publicApiError } from "../../../../../../lib/api-keys/v1-http";
import { recordingParamsSchema } from "../../../../../../lib/recordings/validation";
import { listTranscript } from "../../../../../../lib/transcripts/service";
import { transcriptListSchema } from "../../../../../../lib/transcripts/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireApiKeyActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const url = new URL(request.url);
    const input = transcriptListSchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const result = await listTranscript(
      recordingId,
      {
        userId: actor.apiKeyId,
        workspaceId: actor.workspaceId,
        role: "VIEWER",
      },
      input.cursor,
      input.limit,
    );
    return Response.json(result);
  } catch (error) {
    return publicApiError(error);
  }
}
