import { ZodError } from "zod";
import { UploadContractError } from "@cap/domain";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { UploadReconciliationError } from "./reconcile";
import { UploadServiceError } from "./service";

export function uploadError(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      { error: { code: "VALIDATION_ERROR", issues: error.flatten() } },
      { status: 400 },
    );
  if (error instanceof AuthenticationError)
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  if (error instanceof AuthorizationError)
    return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  if (error instanceof UploadServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  if (
    error instanceof UploadContractError ||
    error instanceof UploadReconciliationError
  )
    return Response.json(
      { error: { code: "UPLOAD_INTEGRITY_ERROR" } },
      { status: 409 },
    );
  if (
    error instanceof Error &&
    error.message === "AWS_UPLOAD_STORAGE_NOT_CONFIGURED"
  )
    return Response.json(
      { error: { code: "UPLOAD_STORAGE_NOT_CONFIGURED" } },
      { status: 503 },
    );
  console.error("upload route failed", error);
  return Response.json(
    { error: { code: "UPLOAD_REQUEST_FAILED" } },
    { status: 500 },
  );
}
