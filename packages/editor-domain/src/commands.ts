import {
  assetIdSchema,
  canvasSchema,
  clipIdSchema,
  clipSchema,
  editorDocumentV2Schema,
  overlayIdSchema,
  overlaySchema,
  trackIdSchema,
  type AssetId,
  type Canvas,
  type Clip,
  type EditorDocumentV2,
  type Overlay,
  type TrackId,
} from "./model";

export type EditorCommand =
  | { readonly type: "ADD_CLIP"; readonly clip: Clip }
  | { readonly type: "REMOVE_CLIP"; readonly clipId: Clip["id"] }
  | { readonly type: "REPLACE_ALL_CLIPS"; readonly clips: readonly Clip[] }
  | {
      readonly type: "REPLACE_CLIP";
      readonly clipId: Clip["id"];
      readonly next: Clip;
    }
  | { readonly type: "ADD_OVERLAY"; readonly overlay: Overlay }
  | { readonly type: "REMOVE_OVERLAY"; readonly overlayId: Overlay["id"] }
  | {
      readonly type: "REPLACE_OVERLAY";
      readonly overlayId: Overlay["id"];
      readonly next: Overlay;
    }
  | { readonly type: "SET_CANVAS"; readonly canvas: Canvas }
  | {
      readonly type: "SET_TRACK_ORDER";
      readonly trackId: TrackId;
      readonly order: number;
    }
  | { readonly type: "ADD_SOURCE_ASSET"; readonly assetId: AssetId }
  | { readonly type: "REMOVE_SOURCE_ASSET"; readonly assetId: AssetId };

export class EditorCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorCommandError";
  }
}

export interface AppliedEditorCommand {
  readonly document: EditorDocumentV2;
  readonly inverse: EditorCommand;
}

export function applyEditorCommand(
  document: EditorDocumentV2,
  command: EditorCommand,
): AppliedEditorCommand {
  const current = editorDocumentV2Schema.parse(document);
  let candidate: unknown;
  let inverse: EditorCommand;
  switch (command.type) {
    case "ADD_CLIP": {
      const clip = clipSchema.parse(command.clip);
      if (current.clips.some((item) => item.id === clip.id))
        throw new EditorCommandError("Clip already exists");
      candidate = { ...current, clips: [...current.clips, clip] };
      inverse = { type: "REMOVE_CLIP", clipId: clip.id };
      break;
    }
    case "REMOVE_CLIP": {
      const id = clipIdSchema.parse(command.clipId);
      const removed = current.clips.find((item) => item.id === id);
      if (!removed) throw new EditorCommandError("Clip does not exist");
      candidate = {
        ...current,
        clips: current.clips.filter((item) => item.id !== id),
      };
      inverse = { type: "ADD_CLIP", clip: removed };
      break;
    }
    case "REPLACE_ALL_CLIPS": {
      const clips = command.clips.map((clip) => clipSchema.parse(clip));
      if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
        throw new EditorCommandError("Clip IDs must be unique");
      candidate = { ...current, clips };
      inverse = { type: "REPLACE_ALL_CLIPS", clips: current.clips };
      break;
    }
    case "REPLACE_CLIP": {
      const id = clipIdSchema.parse(command.clipId);
      const index = current.clips.findIndex((item) => item.id === id);
      if (index < 0) throw new EditorCommandError("Clip does not exist");
      const next = clipSchema.parse(command.next);
      if (next.id !== id)
        throw new EditorCommandError("Replacement clip ID must be stable");
      const clips = [...current.clips];
      const previous = clips[index]!;
      clips[index] = next;
      candidate = { ...current, clips };
      inverse = { type: "REPLACE_CLIP", clipId: id, next: previous };
      break;
    }
    case "ADD_OVERLAY": {
      const overlay = overlaySchema.parse(command.overlay);
      if (current.overlays.some((item) => item.id === overlay.id))
        throw new EditorCommandError("Overlay already exists");
      candidate = { ...current, overlays: [...current.overlays, overlay] };
      inverse = { type: "REMOVE_OVERLAY", overlayId: overlay.id };
      break;
    }
    case "REMOVE_OVERLAY": {
      const id = overlayIdSchema.parse(command.overlayId);
      const removed = current.overlays.find((item) => item.id === id);
      if (!removed) throw new EditorCommandError("Overlay does not exist");
      candidate = {
        ...current,
        overlays: current.overlays.filter((item) => item.id !== id),
      };
      inverse = { type: "ADD_OVERLAY", overlay: removed };
      break;
    }
    case "REPLACE_OVERLAY": {
      const id = overlayIdSchema.parse(command.overlayId);
      const index = current.overlays.findIndex((item) => item.id === id);
      if (index < 0) throw new EditorCommandError("Overlay does not exist");
      const next = overlaySchema.parse(command.next);
      if (next.id !== id)
        throw new EditorCommandError("Replacement overlay ID must be stable");
      const overlays = [...current.overlays];
      const previous = overlays[index]!;
      overlays[index] = next;
      candidate = { ...current, overlays };
      inverse = { type: "REPLACE_OVERLAY", overlayId: id, next: previous };
      break;
    }
    case "SET_CANVAS": {
      const canvas = canvasSchema.parse(command.canvas);
      candidate = { ...current, canvas };
      inverse = { type: "SET_CANVAS", canvas: current.canvas };
      break;
    }
    case "SET_TRACK_ORDER": {
      const id = trackIdSchema.parse(command.trackId);
      if (
        !Number.isInteger(command.order) ||
        command.order < 0 ||
        command.order > 1_000
      )
        throw new EditorCommandError("Track order is invalid");
      const track = current.tracks.find((item) => item.id === id);
      if (!track) throw new EditorCommandError("Track does not exist");
      if (
        current.tracks.some(
          (item) => item.id !== id && item.order === command.order,
        )
      )
        throw new EditorCommandError("Track order must be unique");
      candidate = {
        ...current,
        tracks: current.tracks.map((item) =>
          item.id === id ? { ...item, order: command.order } : item,
        ),
      };
      inverse = { type: "SET_TRACK_ORDER", trackId: id, order: track.order };
      break;
    }
    case "ADD_SOURCE_ASSET": {
      const assetId = assetIdSchema.parse(command.assetId);
      if (current.sourceAssetIds.includes(assetId))
        throw new EditorCommandError("Source asset already attached");
      candidate = {
        ...current,
        sourceAssetIds: [...current.sourceAssetIds, assetId],
      };
      inverse = { type: "REMOVE_SOURCE_ASSET", assetId };
      break;
    }
    case "REMOVE_SOURCE_ASSET": {
      const assetId = assetIdSchema.parse(command.assetId);
      if (!current.sourceAssetIds.includes(assetId))
        throw new EditorCommandError("Source asset is not attached");
      candidate = {
        ...current,
        sourceAssetIds: current.sourceAssetIds.filter((id) => id !== assetId),
      };
      inverse = { type: "ADD_SOURCE_ASSET", assetId };
      break;
    }
  }
  return { document: editorDocumentV2Schema.parse(candidate), inverse };
}

export interface EditorHistory {
  readonly document: EditorDocumentV2;
  readonly undoStack: readonly EditorCommand[];
  readonly redoStack: readonly EditorCommand[];
}

export function createEditorHistory(document: EditorDocumentV2): EditorHistory {
  return {
    document: editorDocumentV2Schema.parse(document),
    undoStack: [],
    redoStack: [],
  };
}

export function executeEditorCommand(
  history: EditorHistory,
  command: EditorCommand,
): EditorHistory {
  const applied = applyEditorCommand(history.document, command);
  return {
    document: applied.document,
    undoStack: [...history.undoStack, applied.inverse],
    redoStack: [],
  };
}

export function undoEditorCommand(history: EditorHistory): EditorHistory {
  const command = history.undoStack.at(-1);
  if (!command) return history;
  const applied = applyEditorCommand(history.document, command);
  return {
    document: applied.document,
    undoStack: history.undoStack.slice(0, -1),
    redoStack: [...history.redoStack, applied.inverse],
  };
}

export function redoEditorCommand(history: EditorHistory): EditorHistory {
  const command = history.redoStack.at(-1);
  if (!command) return history;
  const applied = applyEditorCommand(history.document, command);
  return {
    document: applied.document,
    undoStack: [...history.undoStack, applied.inverse],
    redoStack: history.redoStack.slice(0, -1),
  };
}
