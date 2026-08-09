import { describe, expect, it } from "vitest";
import { initializeEditorDocument } from "@cap/editor-domain";
import {
  editorProjectParamsSchema,
  editorSaveSchema,
  renderParamsSchema,
} from "./validation";

const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const renderJobId = "9f8c8f36-68d7-4f73-bdb6-ec263ba96f84";

describe("editor API validation", () => {
  it("accepts a complete revision CAS request", () => {
    const document = initializeEditorDocument({
      status: "READY",
      recordingId: "recording_1",
      sourceAssetId: "asset_1",
      durationMs: 12_000,
      width: 1920,
      height: 1080,
      frameRate: 30,
    });

    expect(
      editorSaveSchema.parse({
        projectId,
        expectedRevision: 3,
        document,
      }),
    ).toMatchObject({ projectId, expectedRevision: 3 });
  });

  it("rejects unknown fields and invalid revision values", () => {
    expect(() =>
      editorSaveSchema.parse({
        projectId,
        expectedRevision: -1,
        document: {},
        workspaceId: projectId,
      }),
    ).toThrow();
  });

  it("requires UUID route identifiers", () => {
    expect(editorProjectParamsSchema.parse({ projectId })).toEqual({
      projectId,
    });
    expect(renderParamsSchema.parse({ renderJobId })).toEqual({ renderJobId });
    expect(() =>
      editorProjectParamsSchema.parse({ projectId: "../other" }),
    ).toThrow();
  });
});
