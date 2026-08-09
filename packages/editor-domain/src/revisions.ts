import type { EditorDocumentV2, ProjectId } from "./model";

export class EditorRevisionConflictError extends Error {
  constructor() {
    super("Editor project revision changed; reload before saving");
    this.name = "EditorRevisionConflictError";
  }
}

export function nextEditorRevision(
  currentRevision: number,
  expectedRevision: number,
): number {
  if (
    !Number.isInteger(currentRevision) ||
    currentRevision < 0 ||
    expectedRevision !== currentRevision
  ) {
    throw new EditorRevisionConflictError();
  }
  return currentRevision + 1;
}

export interface EditorProjectSnapshot {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  readonly currentRevision: number;
  readonly document: EditorDocumentV2;
  readonly documentHash: string;
}

export interface AppendEditorRevision {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly document: EditorDocumentV2;
  readonly documentHash: string;
  readonly createdBy: string;
}

/**
 * Implementations must insert the immutable revision and CAS project.currentRevision
 * in one transaction scoped by both projectId and workspaceId.
 */
export interface EditorRevisionStore {
  loadProject(
    projectId: ProjectId,
    workspaceId: string,
  ): Promise<EditorProjectSnapshot | undefined>;
  appendRevision(command: AppendEditorRevision): Promise<EditorProjectSnapshot>;
}
