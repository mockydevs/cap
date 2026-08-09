import {
  AuthenticationError,
  requireActor,
} from "../../../../lib/auth/authorization";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    return Response.json({
      user: {
        id: actor.userId,
        email: actor.email,
        displayName: actor.displayName,
      },
      workspace: { id: actor.workspaceId, role: actor.role },
    });
  } catch (error) {
    if (error instanceof AuthenticationError)
      return Response.json(
        { error: { code: "UNAUTHENTICATED" } },
        { status: 401 },
      );
    throw error;
  }
}
