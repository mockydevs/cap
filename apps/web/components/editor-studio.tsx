"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  executeEditorCommand,
  clipIdSchema,
  createEditorHistory,
  redoEditorCommand,
  undoEditorCommand,
  type Clip,
  type EditorCommand,
  type EditorDocumentV2,
  type EditorHistory,
} from "@cap/editor-domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFresh, sendJson } from "../lib/http/json";

type Snapshot = {
  projectId: string;
  revision: number;
  document: EditorDocumentV2;
};
type Revision = {
  revision: number;
  documentHash: string;
  createdAt: string;
  createdBy: string;
};
type Render = {
  id: string;
  projectId: string;
  revision: number;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELED";
  attempt: number;
  errorCategory: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  outputAssetId: string | null;
};
type Playback = { url: string; expiresAt: string };

const ms = (value: number) => `${(value / 1_000).toFixed(2)}s`;
const duration = (clip: Clip) =>
  (clip.sourceEndMs - clip.sourceStartMs) / clip.playbackRate;

export function EditorStudio({ recordingId }: { recordingId: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [history, setHistory] = useState<EditorHistory>();
  const historyRef = useRef<EditorHistory | undefined>(undefined);
  const snapshotRef = useRef<Snapshot | undefined>(undefined);
  const [playback, setPlayback] = useState<Playback>();
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [playheadMs, setPlayheadMs] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [render, setRender] = useState<Render>();
  const [saveState, setSaveState] = useState<
    "loading" | "saved" | "saving" | "conflict" | "error"
  >("loading");
  const [error, setError] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);

  const loadRevisions = useCallback(async (projectId: string) => {
    const response = await fetchFresh(
      `/api/editor-projects/${projectId}/revisions`,
    );
    if (!response.ok) return;
    const body = (await response.json()) as { revisions: Revision[] };
    setRevisions(body.revisions);
  }, []);

  const load = useCallback(async () => {
    setSaveState("loading");
    setError(undefined);
    const response = await fetchFresh(`/api/recordings/${recordingId}/editor`);
    if (response.status === 401) {
      router.replace("/login");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      setError(
        body?.error?.code === "EDITOR_SOURCE_NOT_READY"
          ? "The editor is available after recording processing completes."
          : "Could not load this edit project.",
      );
      setSaveState("error");
      return;
    }
    const next = (await response.json()) as Snapshot;
    snapshotRef.current = next;
    historyRef.current = createEditorHistory(next.document);
    setSnapshot(next);
    setHistory(historyRef.current);
    setSelectedClipId(
      next.document.clips.find((clip) =>
        next.document.tracks.some(
          (track) => track.id === clip.trackId && track.kind === "VIDEO",
        ),
      )?.id,
    );
    setSaveState("saved");
    void loadRevisions(next.projectId);
    const preview = await sendJson(
      `/api/recordings/${recordingId}/playback`,
      "POST",
      {},
    );
    if (preview.ok) setPlayback((await preview.json()) as Playback);
  }, [loadRevisions, recordingId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDocument = useCallback(
    async (document: EditorDocumentV2) => {
      const current = snapshotRef.current;
      if (
        !current ||
        JSON.stringify(document) === JSON.stringify(current.document)
      )
        return current;
      setSaveState("saving");
      const response = await sendJson(
        `/api/recordings/${recordingId}/editor`,
        "PATCH",
        {
          projectId: current.projectId,
          expectedRevision: current.revision,
          document,
        },
      );
      if (response.status === 409) {
        setSaveState("conflict");
        setError(
          "This project changed in another session. Reload before saving.",
        );
        return undefined;
      }
      if (!response.ok) {
        setSaveState("error");
        setError("Autosave failed. Your changes remain in this tab.");
        return undefined;
      }
      const saved = (await response.json()) as Snapshot;
      snapshotRef.current = saved;
      setSnapshot(saved);
      setSaveState("saved");
      void loadRevisions(saved.projectId);
      return saved;
    },
    [loadRevisions, recordingId],
  );

  useEffect(() => {
    if (!history || !snapshot || saveState === "conflict") return;
    if (JSON.stringify(history.document) === JSON.stringify(snapshot.document))
      return;
    const timer = window.setTimeout(
      () => void saveDocument(history.document),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [history, saveDocument, saveState, snapshot]);

  const run = useCallback((command: EditorCommand) => {
    const current = historyRef.current;
    if (!current) return;
    try {
      const next = executeEditorCommand(current, command);
      historyRef.current = next;
      setHistory(next);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "That edit is invalid.",
      );
    }
  }, []);
  const undo = useCallback(() => {
    if (!historyRef.current) return;
    const next = undoEditorCommand(historyRef.current);
    historyRef.current = next;
    setHistory(next);
  }, []);
  const redo = useCallback(() => {
    if (!historyRef.current) return;
    const next = redoEditorCommand(historyRef.current);
    historyRef.current = next;
    setHistory(next);
  }, []);

  const tracks = useMemo(
    () =>
      [...(history?.document.tracks ?? [])].sort((a, b) => a.order - b.order),
    [history],
  );
  const videoTrackIds = useMemo(
    () =>
      new Set(
        tracks
          .filter((track) => track.kind === "VIDEO")
          .map((track) => track.id),
      ),
    [tracks],
  );
  const clips = useMemo(
    () =>
      [...(history?.document.clips ?? [])]
        .filter((clip) => videoTrackIds.has(clip.trackId))
        .sort((left, right) => left.timelineStartMs - right.timelineStartMs),
    [history, videoTrackIds],
  );
  const selected = clips.find((clip) => clip.id === selectedClipId) ?? clips[0];

  useEffect(() => {
    if (selected && selected.id !== selectedClipId)
      setSelectedClipId(selected.id);
  }, [selected, selectedClipId]);

  const trim = (edge: "start" | "end", deltaMs: number) => {
    if (!selected) return;
    const next =
      edge === "start"
        ? {
            ...selected,
            sourceStartMs: selected.sourceStartMs + deltaMs,
            timelineStartMs:
              selected.timelineStartMs + deltaMs / selected.playbackRate,
          }
        : { ...selected, sourceEndMs: selected.sourceEndMs + deltaMs };
    if (next.sourceEndMs - next.sourceStartMs < 250) {
      setError("A clip must remain at least 0.25 seconds long.");
      return;
    }
    run({ type: "REPLACE_CLIP", clipId: selected.id, next });
  };

  const split = () => {
    if (!selected) return;
    const relativeTimeline = playheadMs - selected.timelineStartMs;
    const sourcePoint = Math.round(
      selected.sourceStartMs + relativeTimeline * selected.playbackRate,
    );
    if (
      sourcePoint - selected.sourceStartMs < 250 ||
      selected.sourceEndMs - sourcePoint < 250
    ) {
      setError("Move the playhead inside the selected clip before splitting.");
      return;
    }
    const first = { ...selected, sourceEndMs: sourcePoint };
    const second: Clip = {
      ...selected,
      id: clipIdSchema.parse(`clip_${crypto.randomUUID().replaceAll("-", "")}`),
      sourceStartMs: sourcePoint,
      timelineStartMs:
        selected.timelineStartMs +
        (sourcePoint - selected.sourceStartMs) / selected.playbackRate,
    };
    run({ type: "REPLACE_CLIP", clipId: selected.id, next: first });
    run({ type: "ADD_CLIP", clip: second });
    setSelectedClipId(second.id);
  };

  const reflow = (ordered: Clip[]) => {
    let cursor = 0;
    return ordered.map((clip) => {
      const next = { ...clip, timelineStartMs: cursor };
      cursor += duration(next);
      return next;
    });
  };
  const move = (direction: -1 | 1) => {
    if (!selected) return;
    const index = clips.findIndex((clip) => clip.id === selected.id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= clips.length) return;
    const reordered = [...clips];
    const [clip] = reordered.splice(index, 1);
    reordered.splice(destination, 0, clip!);
    const remaining = history!.document.clips.filter(
      (clip) => !videoTrackIds.has(clip.trackId),
    );
    run({
      type: "REPLACE_ALL_CLIPS",
      clips: [...reflow(reordered), ...remaining],
    });
  };
  const remove = () => {
    if (!selected || clips.length === 1) {
      setError("An export needs at least one video clip.");
      return;
    }
    const remaining = clips.filter((clip) => clip.id !== selected.id);
    const other = history!.document.clips.filter(
      (clip) => !videoTrackIds.has(clip.trackId),
    );
    run({ type: "REPLACE_ALL_CLIPS", clips: [...reflow(remaining), ...other] });
    setSelectedClipId(remaining[0]?.id);
  };

  const requestExport = async () => {
    if (!snapshot || !history) return;
    const saved = await saveDocument(history.document);
    if (!saved) return;
    const response = await sendJson(
      `/api/editor-projects/${saved.projectId}/renders`,
      "POST",
      {},
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      setError(
        body?.error?.code === "RENDER_QUEUE_NOT_CONFIGURED"
          ? "Rendering is not configured for this environment."
          : "This edit cannot be exported by the current renderer.",
      );
      return;
    }
    setRender((await response.json()) as Render);
  };

  useEffect(() => {
    if (!render || render.status === "COMPLETED" || render.status === "FAILED")
      return;
    const timer = window.setInterval(async () => {
      const response = await fetchFresh(
        `/api/editor-projects/${render.projectId}/renders/${render.id}`,
      );
      if (response.ok) setRender((await response.json()) as Render);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [render]);

  if (error && !history)
    return (
      <section className="editor-state-page">
        <div className="editor-state-card">
          <span className="state-mark" aria-hidden="true">
            !
          </span>
          <p className="eyebrow">Editor unavailable</p>
          <h1>We could not open this cut.</h1>
          <p>{error}</p>
          <div className="state-actions">
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
            <Link href={`/library/${recordingId}`}>Back to recording</Link>
          </div>
        </div>
      </section>
    );
  if (!history || !snapshot)
    return (
      <section className="editor-state-page" aria-live="polite">
        <div className="editor-state-card editor-state-loading">
          <span className="state-loader" aria-hidden="true" />
          <p className="eyebrow">Preparing editor</p>
          <h1>Building your timeline.</h1>
          <p>Loading source media, cuts, and saved revisions…</p>
        </div>
      </section>
    );

  return (
    <section className="editor-shell">
      <header className="editor-heading">
        <div>
          <Link className="editor-back" href={`/library/${recordingId}`}>
            ← Back to recording
          </Link>
          <p className="eyebrow">Non-destructive editor</p>
          <h1>Cut the story.</h1>
          <p className="editor-subtitle">
            Tighten the recording without changing the original file.
          </p>
        </div>
        <div className="editor-actions">
          <span className={`editor-save editor-save-${saveState}`}>
            {saveState === "saving"
              ? "Saving…"
              : `Revision ${snapshot.revision}`}
          </span>
          <button
            type="button"
            onClick={undo}
            disabled={!history.undoStack.length}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!history.redoStack.length}
          >
            Redo
          </button>
          <button
            className="editor-export"
            type="button"
            onClick={() => void requestExport()}
          >
            Export MP4
          </button>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}
      <div className="editor-layout">
        <section className="editor-preview" aria-label="Source preview">
          {playback ? (
            <video
              ref={videoRef}
              controls
              src={playback.url}
              onTimeUpdate={(event) =>
                setPlayheadMs(
                  Math.round(event.currentTarget.currentTime * 1_000),
                )
              }
            />
          ) : (
            <div className="processing-state">Loading source preview…</div>
          )}
          <div className="playhead-readout">Playhead {ms(playheadMs)}</div>
          <p className="hint">
            Source preview is used to make frame-accurate cuts. Export renders
            the saved timeline as a new asset; source media is never changed.
          </p>
        </section>
        <aside className="editor-inspector">
          <h2>Clip</h2>
          {selected ? (
            <>
              <p className="hint">
                {ms(selected.sourceStartMs)} – {ms(selected.sourceEndMs)}
              </p>
              <div className="editor-control-grid">
                <button type="button" onClick={() => trim("start", -1_000)}>
                  Extend start
                </button>
                <button type="button" onClick={() => trim("start", 1_000)}>
                  Trim start
                </button>
                <button type="button" onClick={() => trim("end", -1_000)}>
                  Trim end
                </button>
                <button type="button" onClick={() => trim("end", 1_000)}>
                  Extend end
                </button>
                <button type="button" onClick={split}>
                  Split at playhead
                </button>
                <button
                  className="editor-danger"
                  type="button"
                  onClick={remove}
                >
                  Delete clip
                </button>
                <button type="button" onClick={() => move(-1)}>
                  Move earlier
                </button>
                <button type="button" onClick={() => move(1)}>
                  Move later
                </button>
              </div>
            </>
          ) : (
            <p className="hint">Select a clip on the timeline.</p>
          )}
          <h2>Versions</h2>
          <ol className="editor-revisions">
            {revisions.slice(0, 8).map((revision) => (
              <li key={revision.revision}>
                <span>Revision {revision.revision}</span>
                <time dateTime={revision.createdAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(revision.createdAt))}
                </time>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      <section className="editor-timeline" aria-label="Timeline">
        <div className="editor-timeline-heading">
          <div>
            <p className="eyebrow">Sequence</p>
            <h2>Timeline</h2>
          </div>
          <div className="editor-timeline-meta">
            <span>
              {clips.length} {clips.length === 1 ? "clip" : "clips"}
            </span>
            <strong>{ms(history.document.timelineDurationMs)}</strong>
          </div>
        </div>
        <div className="editor-track">
          <span>Video</span>
          <div className="editor-track-clips">
            {clips.map((clip) => (
              <button
                className={clip.id === selected?.id ? "selected" : ""}
                key={clip.id}
                type="button"
                onClick={() => {
                  setSelectedClipId(clip.id);
                  setPlayheadMs(clip.timelineStartMs);
                  if (videoRef.current)
                    videoRef.current.currentTime = clip.sourceStartMs / 1_000;
                }}
                style={{ flexGrow: Math.max(1, duration(clip) / 1_000) }}
              >
                {ms(duration(clip))}
              </button>
            ))}
          </div>
        </div>
      </section>
      {render && (
        <section className="editor-render" aria-live="polite">
          <strong>Export {render.status.toLowerCase()}</strong>
          <span>Attempt {render.attempt}</span>
          {render.status === "FAILED" && render.errorCategory && (
            <span className="form-error">{render.errorCategory}</span>
          )}
          {render.status === "COMPLETED" && (
            <a
              className="editor-download"
              href={`/api/editor-projects/${render.projectId}/renders/${render.id}/download`}
            >
              Download MP4
            </a>
          )}
        </section>
      )}
    </section>
  );
}
