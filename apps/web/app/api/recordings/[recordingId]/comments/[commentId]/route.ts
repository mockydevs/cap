import {
  AuthorizationError,
  requireActor,
} from "../../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../../lib/auth/origin";
import { commentError } from "../../../../../../lib/comments/http";
import {
  changeComment,
  memberIdentity,
} from "../../../../../../lib/comments/service";
import {
  commentParamsSchema,
  updateCommentSchema,
} from "../../../../../../lib/comments/validation";
async function identity(
  request: Request,
  context: { params: Promise<{ recordingId: string; commentId: string }> },
) {
  if (!hasTrustedOrigin(request))
    throw new AuthorizationError("Invalid origin");
  const actor = await requireActor(request);
  const params = commentParamsSchema.required().parse(await context.params);
  return { actor, ...params };
}
export async function PATCH(
  request: Request,
  context: { params: Promise<{ recordingId: string; commentId: string }> },
) {
  try {
    const value = await identity(request, context);
    const input = updateCommentSchema.parse(await request.json());
    await changeComment(
      value.recordingId,
      value.commentId,
      memberIdentity(value.actor),
      input.body,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return commentError(error);
  }
}
export async function DELETE(
  request: Request,
  context: { params: Promise<{ recordingId: string; commentId: string }> },
) {
  try {
    const value = await identity(request, context);
    await changeComment(
      value.recordingId,
      value.commentId,
      memberIdentity(value.actor),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return commentError(error);
  }
}
