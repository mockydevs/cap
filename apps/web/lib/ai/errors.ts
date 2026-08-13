/**
 * Kept out of `service.ts` so the entitlement loader can raise it without the
 * two modules importing each other.
 */
export class AiServiceError extends Error {
  constructor(
    readonly code:
      | "AI_DISABLED"
      | "EXTERNAL_AI_DISABLED"
      | "TRANSCRIPT_NOT_READY"
      | "AI_QUOTA_EXCEEDED"
      | "AI_CREDIT_EXHAUSTED"
      | "AI_NOT_FOUND"
      | "AI_QUEUE_NOT_CONFIGURED"
      | "AI_PROVIDER_NOT_CONFIGURED"
      | "AI_PROVIDER_VALIDATION_FAILED"
      | "AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE",
    readonly status: number,
  ) {
    super(code);
    this.name = "AiServiceError";
  }
}
