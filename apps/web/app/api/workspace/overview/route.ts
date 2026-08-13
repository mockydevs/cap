import { requireActor } from "../../../../lib/auth/authorization";
import { recordingError } from "../../../../lib/recordings/http";
import { workspaceOverview } from "../../../../lib/recordings/overview";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return Response.json(await workspaceOverview(actor));
  } catch (error) {
    return recordingError(error);
  }
}
