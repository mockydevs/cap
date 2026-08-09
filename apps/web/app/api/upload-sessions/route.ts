import {
  requireTrustedUploadOrigin,
  requireUploadActor,
} from "../../../lib/uploads/auth";
import { uploadError } from "../../../lib/uploads/http";
import { initiateSourceUpload } from "../../../lib/uploads/service";
import { createUploadSchema } from "../../../lib/uploads/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireTrustedUploadOrigin(request);
    const actor = await requireUploadActor(request);
    const input = createUploadSchema.parse(await request.json());
    return Response.json(await initiateSourceUpload(actor, input), {
      status: 201,
    });
  } catch (error) {
    return uploadError(error);
  }
}
