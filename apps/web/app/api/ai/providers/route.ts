import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { aiError } from "../../../../lib/ai/http";
import {
  createProviderConnection,
  listProviderConnections,
} from "../../../../lib/ai/provider-connections";
import { providerConnectionSchema } from "../../../../lib/ai/validation";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(
      await listProviderConnections(await requireActor(request, "ADMIN")),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return aiError(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    return Response.json(
      await createProviderConnection(
        await requireActor(request, "ADMIN"),
        providerConnectionSchema.parse(await request.json()),
      ),
      { status: 201 },
    );
  } catch (error) {
    return aiError(error);
  }
}
