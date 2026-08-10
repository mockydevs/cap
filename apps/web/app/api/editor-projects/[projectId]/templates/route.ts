import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { editorError } from "../../../../../lib/editor/http";
import { createTemplateFromProject } from "../../../../../lib/editor/service";
import {
  createTemplateSchema,
  editorProjectParamsSchema,
} from "../../../../../lib/editor/validation";

export const runtime = "nodejs";

/** Captures this project's current timeline as a reusable, workspace-owned template. */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const { projectId } = editorProjectParamsSchema.parse(await context.params);
    const input = createTemplateSchema.parse(await request.json());
    return Response.json(
      await createTemplateFromProject(actor, projectId, input),
      { status: 201 },
    );
  } catch (error) {
    return editorError(error);
  }
}
