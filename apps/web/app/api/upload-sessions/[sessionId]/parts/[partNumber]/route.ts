import {
  requireTrustedUploadOrigin,
  requireUploadActor,
} from "../../../../../../lib/uploads/auth";
import { uploadError } from "../../../../../../lib/uploads/http";
import { signSourceUploadPart } from "../../../../../../lib/uploads/service";
import {
  partParamsSchema,
  signPartSchema,
} from "../../../../../../lib/uploads/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string; partNumber: string }> },
) {
  try {
    requireTrustedUploadOrigin(request);
    const actor = await requireUploadActor(request);
    const parameters = partParamsSchema.parse(await context.params);
    const input = signPartSchema.parse(await request.json());
    return Response.json(
      await signSourceUploadPart(
        actor,
        parameters.sessionId,
        parameters.partNumber,
        input,
      ),
    );
  } catch (error) {
    return uploadError(error);
  }
}
