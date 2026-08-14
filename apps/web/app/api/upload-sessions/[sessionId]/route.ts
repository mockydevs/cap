import {
  requireTrustedUploadOrigin,
  requireUploadActor,
} from "../../../../lib/uploads/auth";
import { uploadError } from "../../../../lib/uploads/http";
import {
  abortSourceUpload,
  reportSourceUploadProgress,
} from "../../../../lib/uploads/service";
import {
  reportUploadProgressSchema,
  sessionParamsSchema,
} from "../../../../lib/uploads/validation";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    requireTrustedUploadOrigin(request);
    const actor = await requireUploadActor(request);
    const { sessionId } = sessionParamsSchema.parse(await context.params);
    const input = reportUploadProgressSchema.parse(await request.json());
    return Response.json(
      await reportSourceUploadProgress(actor, sessionId, input),
    );
  } catch (error) {
    return uploadError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    requireTrustedUploadOrigin(request);
    const actor = await requireUploadActor(request);
    const { sessionId } = sessionParamsSchema.parse(await context.params);
    await abortSourceUpload(actor, sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return uploadError(error);
  }
}
