"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatDate } from "../lib/format/display";
import { fetchFresh, sendJson } from "../lib/http/json";
import { ShareControls } from "./share-controls";
import { CommentThread } from "./comment-thread";
import { TranscriptPanel } from "./transcript-panel";
import { AiPanel } from "./ai-panel";
import { RecordingAnalytics } from "./recording-analytics";

type Recording = {
  id: string;
  title: string;
  status: "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
  sizeBytes: number | null;
  createdAt: string;
  canManageSharing: boolean;
  uploadProgress?: {
    phase: "PENDING" | "UPLOADING" | "COMPLETING";
    recordedBytes: number;
    uploadedBytes: number;
    percent: number;
    lastError: string | null;
    updatedAt: string;
  } | null;
};
type Playback = {
  url: string;
  expiresAt: string;
};
type InspectorTab = "transcript" | "comments" | "ai" | "analytics";

export function RecordingViewer({
  recordingId,
  initialTimestampMs,
}: {
  recordingId: string;
  initialTimestampMs?: number;
}) {
  const router = useRouter();
  const [recording, setRecording] = useState<Recording>();
  const [observedAt, setObservedAt] = useState(0);
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState<string>();
  const [timestampMs, setTimestampMs] = useState(0);
  const [activeTab, setActiveTab] = useState<InspectorTab>("transcript");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const playerRef = useRef<HTMLVideoElement>(null);
  const load = useCallback(async () => {
    const response = await fetchFresh(`/api/recordings/${recordingId}`);
    if (response.status === 401) {
      router.replace("/login");
      return;
    }
    if (response.status === 404) {
      setError("Recording not found in this workspace.");
      return;
    }
    if (!response.ok) {
      setError("Could not load this recording.");
      return;
    }
    const next = (await response.json()) as Recording;
    setRecording(next);
    setObservedAt(Date.now());
    if (
      next.status === "PROCESSING" ||
      next.status === "READY" ||
      next.status === "FAILED"
    ) {
      const media = await sendJson(
        `/api/recordings/${recordingId}/playback`,
        "POST",
        {},
      );
      if (media.ok) {
        setPlayback((await media.json()) as Playback);
        setError(undefined);
      } else if (next.status === "READY") {
        setError("Playback is temporarily unavailable.");
      }
    }
  }, [recordingId, router]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      !recording ||
      (recording.status !== "UPLOADING" && recording.status !== "PROCESSING")
    )
      return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [recording, load]);
  useEffect(() => {
    if (!playback || !playerRef.current || initialTimestampMs === undefined)
      return;
    playerRef.current.currentTime = initialTimestampMs / 1_000;
  }, [playback, initialTimestampMs]);
  if (error)
    return (
      <section className="viewer-shell viewer-state-page">
        <div className="viewer-state-card">
          <span className="state-code">Playback unavailable</span>
          <h1>We couldn&apos;t open this recording.</h1>
          <p className="form-error">{error}</p>
          <Link className="btn btn-secondary" href="/library">
            Return to library
          </Link>
        </div>
      </section>
    );
  if (!recording)
    return (
      <section className="viewer-shell viewer-state-page" aria-live="polite">
        <div className="viewer-state-card viewer-loading-card">
          <span className="processing-pulse" />
          <p className="eyebrow">Loading recording</p>
          <h1>Preparing your workspace.</h1>
        </div>
      </section>
    );
  const uploadProgress = recording.uploadProgress;
  const uploadStalled =
    recording.status === "UPLOADING" &&
    (!uploadProgress ||
      Boolean(uploadProgress.lastError) ||
      observedAt - new Date(uploadProgress.updatedAt).getTime() > 60_000);
  async function saveTitle() {
    if (!recording) return;
    const title = titleDraft.trim();
    if (!title || title === recording.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    const response = await sendJson(
      `/api/recordings/${recording.id}`,
      "PATCH",
      {
        title,
      },
    );
    setSavingTitle(false);
    if (!response.ok) {
      setError("Could not rename this recording.");
      return;
    }
    setRecording((current) => (current ? { ...current, title } : current));
    setEditingTitle(false);
  }
  return (
    <section className="viewer-shell">
      <div className="viewer-context">
        <Link className="viewer-back" href="/library">
          <span aria-hidden="true">←</span>
          All recordings
        </Link>
        <div className="viewer-actions">
          {recording.status === "READY" && (
            <Link
              className="btn btn-secondary"
              href={`/library/${recording.id}/edit`}
            >
              Edit recording
            </Link>
          )}
        </div>
      </div>
      <div className="viewer-layout">
        <div className="viewer-main">
          <div className="viewer-heading">
            <div className="viewer-title">
              <span
                className={`viewer-status viewer-status-${recording.status.toLowerCase()}`}
              >
                {recording.status === "UPLOADING"
                  ? "Uploading"
                  : recording.status === "PROCESSING"
                    ? "Processing"
                    : recording.status === "READY"
                      ? "Ready"
                      : "Failed"}
              </span>
              <div className="viewer-title-row">
                {editingTitle ? (
                  <form
                    className="viewer-title-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveTitle();
                    }}
                  >
                    <label className="sr-only" htmlFor="recording-title">
                      Recording title
                    </label>
                    <input
                      id="recording-title"
                      value={titleDraft}
                      maxLength={160}
                      autoFocus
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingTitle(false);
                      }}
                    />
                    <button disabled={savingTitle || !titleDraft.trim()}>
                      {savingTitle ? "Saving…" : "Save"}
                    </button>
                    <button
                      className="btn-secondary"
                      type="button"
                      disabled={savingTitle}
                      onClick={() => setEditingTitle(false)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <h1>{recording.title}</h1>
                    {recording.canManageSharing && (
                      <button
                        type="button"
                        className="title-edit-button"
                        aria-label="Rename recording"
                        title="Rename recording"
                        onClick={() => {
                          setTitleDraft(recording.title);
                          setEditingTitle(true);
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m4 16-.8 4.8L8 20 19.2 8.8l-4-4L4 16Zm12.6-12.6 1.1-1.1a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8l-1.1 1.1-4-4Z" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            <dl className="viewer-meta">
              <div>
                <dt>Created</dt>
                <dd>{formatDate(recording.createdAt)}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>
                  {recording.sizeBytes
                    ? formatBytes(recording.sizeBytes)
                    : "Processing"}
                </dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>{recording.canManageSharing ? "Owner" : "Workspace"}</dd>
              </div>
            </dl>
          </div>
          {playback ? (
            <video
              ref={playerRef}
              className="playback-player"
              controls
              preload="metadata"
              src={playback.url}
              onTimeUpdate={(event) =>
                setTimestampMs(event.currentTarget.currentTime * 1000)
              }
              onError={() => void load()}
            >
              <track
                default
                kind="subtitles"
                label="Transcript"
                src={`/api/recordings/${recordingId}/captions?format=vtt`}
                srcLang="en"
              />
            </video>
          ) : (
            <div className="processing-state">
              <span className="processing-pulse" />
              <h2>
                {recording.status === "FAILED"
                  ? "Processing failed"
                  : recording.status === "UPLOADING"
                    ? "Uploading recording…"
                    : "Preparing playback…"}
              </h2>
              {recording.status === "UPLOADING" && uploadProgress && (
                <div className="viewer-upload-progress" aria-live="polite">
                  <div className="viewer-upload-progress-copy">
                    <strong>{uploadProgress.percent}%</strong>
                    <span>
                      {formatBytes(uploadProgress.uploadedBytes)} of{" "}
                      {formatBytes(uploadProgress.recordedBytes)} secured
                    </span>
                  </div>
                  <div
                    className="upload-progress-track"
                    role="progressbar"
                    aria-label="Recording upload progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={uploadProgress.percent}
                  >
                    <span style={{ width: `${uploadProgress.percent}%` }} />
                  </div>
                </div>
              )}
              {recording.status === "UPLOADING" && uploadStalled && (
                <div className="viewer-upload-recovery" role="alert">
                  <p>
                    {uploadProgress?.lastError ??
                      "No upload activity has reached the server recently."}
                  </p>
                  <Link className="btn btn-secondary" href="/record">
                    Resume from this browser
                  </Link>
                </div>
              )}
              {recording.status === "FAILED" && (
                <p>
                  The source is safe. Contact a workspace administrator to retry
                  processing.
                </p>
              )}
            </div>
          )}
          {recording.canManageSharing && (
            <ShareControls recordingId={recording.id} />
          )}
        </div>
        <aside className="viewer-inspector">
          <div
            className="viewer-tabs"
            role="tablist"
            aria-label="Recording details"
          >
            {(
              [
                "transcript",
                "comments",
                "ai",
                ...(recording.canManageSharing ? (["analytics"] as const) : []),
              ] as const
            ).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={activeTab === tab ? "active" : ""}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "ai"
                  ? "AI"
                  : `${tab[0]!.toUpperCase()}${tab.slice(1)}`}
              </button>
            ))}
          </div>
          <div className="viewer-tab-panel" role="tabpanel">
            {activeTab === "transcript" && (
              <TranscriptPanel
                recordingId={recording.id}
                onSeek={(positionMs) => {
                  if (!playerRef.current) return;
                  playerRef.current.currentTime = positionMs / 1_000;
                  void playerRef.current.play().catch(() => undefined);
                }}
              />
            )}
            {activeTab === "comments" && (
              <CommentThread
                recordingId={recording.id}
                timestampMs={timestampMs}
              />
            )}
            {activeTab === "ai" && (
              <AiPanel
                recordingId={recording.id}
                onSeek={(positionMs) => {
                  if (!playerRef.current) return;
                  playerRef.current.currentTime = positionMs / 1000;
                  void playerRef.current.play().catch(() => undefined);
                }}
              />
            )}
            {activeTab === "analytics" && (
              <RecordingAnalytics recordingId={recording.id} />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
