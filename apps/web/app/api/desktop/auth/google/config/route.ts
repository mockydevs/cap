export const runtime = "nodejs";

export async function GET() {
  const clientId = process.env.GOOGLE_DESKTOP_OAUTH_CLIENT_ID;
  if (!clientId)
    return Response.json(
      { error: { code: "GOOGLE_DESKTOP_OAUTH_NOT_CONFIGURED" } },
      { status: 503 },
    );
  return Response.json(
    { clientId },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
