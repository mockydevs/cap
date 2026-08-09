import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { EditorError } from "./service";

export function editorError(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      { error: { code: "VALIDATION_ERROR" } },
      { status: 400 },
    );
  if (error instanceof AuthenticationError)
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  if (error instanceof AuthorizationError)
    return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  if (error instanceof EditorError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  console.error("editor route failed", error);
  return Response.json(
    { error: { code: "EDITOR_REQUEST_FAILED" } },
    { status: 500 },
  );
}
