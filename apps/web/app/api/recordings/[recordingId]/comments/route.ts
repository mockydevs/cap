import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { commentError } from "../../../../../lib/comments/http";
import { enforceCommentRateLimit } from "../../../../../lib/comments/rate-limit";
import {
  createComment,
  listComments,
  memberIdentity,
} from "../../../../../lib/comments/service";
import {
  commentParamsSchema,
  createCommentSchema,
  listCommentsSchema,
} from "../../../../../lib/comments/validation";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request);
    const { recordingId } = commentParamsSchema.parse(await context.params);
    const url = new URL(request.url);
    const input = listCommentsSchema.parse(
      Object.fromEntries(url.searchParams),
    );
    return Response.json(
      await listComments(
        recordingId,
        memberIdentity(actor),
        input.cursor ? new Date(input.cursor) : undefined,
        input.limit,
      ),
    );
  } catch (error) {
    return commentError(error);
  }
}
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
    const actor = await requireActor(request);
    await enforceCommentRateLimit(request, actor.userId);
    const { recordingId } = commentParamsSchema.parse(await context.params);
    const input = createCommentSchema.parse(await request.json());
    return Response.json(
      await createComment(
        recordingId,
        memberIdentity(actor),
        input.body,
        input.timestampMs,
      ),
      { status: 201 },
    );
  } catch (error) {
    return commentError(error);
  }
}
