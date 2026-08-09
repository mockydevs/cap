import {
  requireTrustedUploadOrigin,
  requireUploadActor,
} from "../../../../../lib/uploads/auth";
import { uploadError } from "../../../../../lib/uploads/http";
import { completeSourceUpload } from "../../../../../lib/uploads/service";
import {
  completeUploadSchema,
  idempotencyKeySchema,
  sessionParamsSchema,
} from "../../../../../lib/uploads/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    requireTrustedUploadOrigin(request);
    const actor = await requireUploadActor(request);
    const { sessionId } = sessionParamsSchema.parse(await context.params);
    const idempotencyKey = idempotencyKeySchema.parse(
      request.headers.get("idempotency-key"),
    );
    const { parts } = completeUploadSchema.parse(await request.json());
    return Response.json(
      await completeSourceUpload(actor, sessionId, idempotencyKey, parts),
    );
  } catch (error) {
    return uploadError(error);
  }
}
