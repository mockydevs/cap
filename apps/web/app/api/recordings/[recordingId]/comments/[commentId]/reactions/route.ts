import { requireActor } from "../../../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../../../lib/auth/origin";
import { commentError } from "../../../../../../../lib/comments/http";
import {
  memberIdentity,
  setReaction,
} from "../../../../../../../lib/comments/service";
import {
  commentParamsSchema,
  reactionSchema,
} from "../../../../../../../lib/comments/validation";
export async function PUT(
  request: Request,
  context: { params: Promise<{ recordingId: string; commentId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request);
    const params = commentParamsSchema.required().parse(await context.params);
    const input = reactionSchema.parse(await request.json());
    await setReaction(
      params.recordingId,
      params.commentId,
      memberIdentity(actor),
      input.emoji,
      input.active,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return commentError(error);
  }
}
