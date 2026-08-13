import {
  requireTrustedUploadOrigin,
  requireUploadActor,
} from "../../../../../lib/uploads/auth";
import { uploadError } from "../../../../../lib/uploads/http";
import { restartSourceUpload } from "../../../../../lib/uploads/service";
import { sessionParamsSchema } from "../../../../../lib/uploads/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    requireTrustedUploadOrigin(request);
    const actor = await requireUploadActor(request);
    const { sessionId } = sessionParamsSchema.parse(await context.params);
    return Response.json(await restartSourceUpload(actor, sessionId), {
      status: 201,
    });
  } catch (error) {
    return uploadError(error);
  }
}
