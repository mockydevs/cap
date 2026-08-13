import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";
import { transcriptError } from "../../../../../lib/transcripts/http";
import {
  listTranscript,
  requestTranscription,
  updateTranscriptLanguage,
} from "../../../../../lib/transcripts/service";
import {
  transcriptLanguageUpdateSchema,
  transcriptListSchema,
} from "../../../../../lib/transcripts/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const input = transcriptListSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(
      await listTranscript(recordingId, actor, input.cursor, input.limit),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return transcriptError(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const input = transcriptLanguageUpdateSchema.parse(await request.json());
    return Response.json(
      await updateTranscriptLanguage(recordingId, actor, input.language),
    );
  } catch (error) {
    return transcriptError(error);
  }
}

/** Re-requests transcription, for a recording that has none or whose
 * transcript was disabled because the workspace could not pay for AI. */
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
    const actor = await requireActor(request, "MEMBER");
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    return Response.json(await requestTranscription(recordingId, actor));
  } catch (error) {
    return transcriptError(error);
  }
}
