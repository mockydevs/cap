import { ZodError } from "zod";

export function uploadError(error: unknown) {
  if (error instanceof ZodError) return Response.json({ error: { code: "VALIDATION_ERROR", issues: error.flatten() } }, { status: 400 });
  if (error instanceof Error && error.message === "UPLOAD_AUTH_NOT_CONFIGURED") return Response.json({ error: { code: "AUTH_NOT_CONFIGURED" } }, { status: 503 });
  console.error("upload route failed", error);
  return Response.json({ error: { code: "UPLOAD_REQUEST_FAILED" } }, { status: 500 });
}
