import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { commentError } from "../../../../../lib/comments/http";
import { enforceCommentRateLimit } from "../../../../../lib/comments/rate-limit";
import {
  changeComment,
  createComment,
  guestIdentity,
  listComments,
  setReaction,
} from "../../../../../lib/comments/service";
import {
  createCommentSchema,
  reactionSchema,
  updateCommentSchema,
} from "../../../../../lib/comments/validation";
import { shareTokenParamsSchema } from "../../../../../lib/sharing/validation";
import { z } from "zod";
const base = z.object({
  guestName: z.string().trim().min(2).max(80),
  viewerKey: z.string().uuid(),
});
const actionSchema = z.discriminatedUnion("action", [
  base.extend({
    action: z.literal("list"),
    cursor: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(50).default(30),
  }),
  base.merge(createCommentSchema).extend({ action: z.literal("create") }),
  base
    .merge(updateCommentSchema)
    .extend({ action: z.literal("update"), commentId: z.string().uuid() }),
  base.extend({ action: z.literal("delete"), commentId: z.string().uuid() }),
  base
    .merge(reactionSchema)
    .extend({ action: z.literal("reaction"), commentId: z.string().uuid() }),
]);
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const { token } = shareTokenParamsSchema.parse(await context.params);
    const input = actionSchema.parse(await request.json());
    await enforceCommentRateLimit(request, token);
    const guest = await guestIdentity(
      request,
      token,
      input.guestName,
      input.viewerKey,
    );
    if (input.action === "list")
      return Response.json(
        await listComments(
          guest.recordingId,
          guest.identity,
          input.cursor ? new Date(input.cursor) : undefined,
          input.limit,
        ),
      );
    if (input.action === "create")
      return Response.json(
        await createComment(
          guest.recordingId,
          guest.identity,
          input.body,
          input.timestampMs,
        ),
        { status: 201 },
      );
    if (input.action === "update") {
      await changeComment(
        guest.recordingId,
        input.commentId,
        guest.identity,
        input.body,
      );
      return new Response(null, { status: 204 });
    }
    if (input.action === "delete") {
      await changeComment(guest.recordingId, input.commentId, guest.identity);
      return new Response(null, { status: 204 });
    }
    await setReaction(
      guest.recordingId,
      input.commentId,
      guest.identity,
      input.emoji,
      input.active,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return commentError(error);
  }
}
