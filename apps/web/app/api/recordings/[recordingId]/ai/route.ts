import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { aiError } from "../../../../../lib/ai/http";
import { createAiJob, listAi } from "../../../../../lib/ai/service";
import { createAiJobSchema } from "../../../../../lib/ai/validation";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  try {
    return Response.json(
      {
        items: await listAi(
          (await params).recordingId,
          await requireActor(request),
        ),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return aiError(error);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const input = createAiJobSchema.parse(await request.json());
    return Response.json(
      await createAiJob((await params).recordingId, actor, {
        capability: input.capability,
        ...(input.question ? { question: input.question } : {}),
        ...(input.targetLanguage
          ? { targetLanguage: input.targetLanguage }
          : {}),
      }),
      { status: 202 },
    );
  } catch (error) {
    return aiError(error);
  }
}
