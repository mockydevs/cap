import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../db/client";
import { uploadSessions } from "../../../../../../db/schema";
import { requireUploadActor } from "../../../../../../lib/uploads/auth";
import { uploadError } from "../../../../../../lib/uploads/http";
import { signUploadPart } from "../../../../../../lib/uploads/s3";
import { sessionParamsSchema, signPartSchema } from "../../../../../../lib/uploads/validation";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ sessionId: string; partNumber: string }> }) {
  try {
    const actor = requireUploadActor();
    const parameters = sessionParamsSchema.parse(await context.params);
    const partNumber = signPartSchema.parse({ partNumber: Number((await context.params).partNumber) }).partNumber;
    const [session] = await db().select().from(uploadSessions).where(and(eq(uploadSessions.id, parameters.sessionId), eq(uploadSessions.workspaceId, actor.workspaceId), eq(uploadSessions.status, "ACTIVE")));
    if (!session || session.expiresAt < new Date()) return Response.json({ error: { code: "UPLOAD_SESSION_NOT_FOUND" } }, { status: 404 });
    return Response.json({ url: await signUploadPart(session.objectKey, session.s3UploadId, partNumber), expiresInSeconds: 300 });
  } catch (error) { return uploadError(error); }
}
