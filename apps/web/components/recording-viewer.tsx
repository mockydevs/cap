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

type Recording = {
  id: string;
  title: string;
  status: "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
  sizeBytes: number | null;
  createdAt: string;
  canManageSharing: boolean;
};
type Playback = {
  url: string;
  expiresAt: string;
};
type InspectorTab = "transcript" | "comments" | "ai";

export function RecordingViewer({
  recordingId,
  initialTimestampMs,
}: {
  recordingId: string;
  initialTimestampMs?: number;
}) {
  const router = useRouter();
  const [recording, setRecording] = useState<Recording>();
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState<string>();
  const [timestampMs, setTimestampMs] = useState(0);
  const [activeTab, setActiveTab] = useState<InspectorTab>("transcript");
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
              <h1>{recording.title}</h1>
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
            {(["transcript", "comments", "ai"] as const).map((tab) => (
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
          </div>
        </aside>
      </div>
    </section>
  );
}
