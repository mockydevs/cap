import { requireActor } from "../../../../lib/auth/authorization";
import { transcriptError } from "../../../../lib/transcripts/http";
import { searchWorkspaceTranscripts } from "../../../../lib/transcripts/service";
import { transcriptSearchSchema } from "../../../../lib/transcripts/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const input = transcriptSearchSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(
      await searchWorkspaceTranscripts(
        actor,
        input.q,
        input.cursor,
        input.limit,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return transcriptError(error);
  }
}
