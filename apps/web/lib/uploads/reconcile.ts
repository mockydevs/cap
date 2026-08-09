import {
  createUploadPlan,
  s3EntityTag,
  sha256Base64,
  verifyCompletedUpload,
  type CompletedUploadPart,
  type VerifiedCompletedUpload,
} from "@cap/domain";

export interface PersistedPartIntent {
  readonly partNumber: number;
  readonly contentLength: number;
  readonly checksumSha256: string;
  readonly isFinalPart: boolean;
}

export interface BrowserCompletedPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksumSha256: string;
}

export class UploadReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadReconciliationError";
  }
}

/** Reconciles persisted intent, the browser receipt, and authoritative S3 ListParts. */
export function reconcileCompletedParts(input: {
  readonly partSizeBytes: number;
  readonly expectedSizeBytes: number;
  readonly intents: readonly PersistedPartIntent[];
  readonly browserParts: readonly BrowserCompletedPart[];
  readonly storedParts: readonly CompletedUploadPart[];
}): VerifiedCompletedUpload {
  const plan = createUploadPlan({
    partSizeBytes: input.partSizeBytes,
    maxUploadBytes: input.expectedSizeBytes,
  });
  const intents = [...input.intents].sort(
    (left, right) => left.partNumber - right.partNumber,
  );
  const browserParts = [...input.browserParts].sort(
    (left, right) => left.partNumber - right.partNumber,
  );
  const storedParts = [...input.storedParts].sort(
    (left, right) => left.partNumber - right.partNumber,
  );

  if (
    intents.length !== browserParts.length ||
    intents.length !== storedParts.length
  ) {
    throw new UploadReconciliationError(
      "Part manifests do not contain the same number of parts",
    );
  }

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];
    const browser = browserParts[index];
    const stored = storedParts[index];
    if (!intent || !browser || !stored) {
      throw new UploadReconciliationError("Part manifest contains a gap");
    }
    const shouldBeFinal = index === intents.length - 1;
    if (
      intent.partNumber !== index + 1 ||
      intent.isFinalPart !== shouldBeFinal
    ) {
      throw new UploadReconciliationError(
        "Persisted part intents are not contiguous and final",
      );
    }
    if (
      browser.partNumber !== intent.partNumber ||
      stored.partNumber !== intent.partNumber ||
      browser.checksumSha256 !== intent.checksumSha256 ||
      stored.checksumSha256 !== intent.checksumSha256 ||
      browser.etag !== stored.etag
    ) {
      throw new UploadReconciliationError(
        "Browser, intent, and S3 part metadata do not match",
      );
    }
    sha256Base64(browser.checksumSha256);
    s3EntityTag(browser.etag);
  }

  const verified = verifyCompletedUpload(plan, storedParts);
  if (verified.totalBytes !== input.expectedSizeBytes) {
    throw new UploadReconciliationError(
      "Uploaded bytes do not match the declared source size",
    );
  }
  return verified;
}
