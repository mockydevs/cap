import type {
  RecordingId,
  SourceMediaType,
  UploadSessionId,
  WorkspaceId,
} from "@cap/domain";

declare const mediaObjectKeyBrand: unique symbol;

/** A key rooted in Cap's managed workspace namespace, never raw user input. */
export type MediaObjectKey = string & { readonly [mediaObjectKeyBrand]: true };

const managedKeyPattern =
  /^workspaces\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/recordings\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/(?:source|playback|thumbnails|transcripts|exports|tmp)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;

export class InvalidMediaObjectKeyError extends Error {
  constructor() {
    super("Object key is outside the managed media namespace");
    this.name = "InvalidMediaObjectKeyError";
  }
}

export function assertManagedMediaObjectKey(value: string): MediaObjectKey {
  if (!managedKeyPattern.test(value) || value.includes("..")) {
    throw new InvalidMediaObjectKeyError();
  }
  return value as MediaObjectKey;
}

const sourceExtensions: Readonly<Record<SourceMediaType, string>> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

/**
 * Each attempt gets a fresh immutable key. User-provided filenames and titles
 * are intentionally absent from the key.
 */
export function buildSourceMediaObjectKey(input: {
  readonly workspaceId: WorkspaceId;
  readonly recordingId: RecordingId;
  readonly uploadSessionId: UploadSessionId;
  readonly mediaType: SourceMediaType;
}): MediaObjectKey {
  return assertManagedMediaObjectKey(
    `workspaces/${input.workspaceId}/recordings/${input.recordingId}/source/${input.uploadSessionId}.${sourceExtensions[input.mediaType]}`,
  );
}
